package com.uwoacrimson.yesimbot

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * Keeps the app current (user, 2026-11-26: 「app需要一个增量更新」). The pages come from the site, so every deploy
 * reaches the app at once; only this shell is ever installed again. The site publishes `/downloads/android.json`
 * (scripts/publish-android.mjs). A newer version is offered once per launch; the APK (a few hundred KB) is checked
 * against the manifest's size and SHA-256 and against this app's package name, version and signing key, then handed to
 * the system installer, which keeps the app's data and the signed-in session.
 */
class Updater(private val activity: Activity, private val site: Uri, private val userAgent: String) {
  private class Release(val versionCode: Long, val versionName: String, val url: URL, val size: Long, val sha256: String)

  private var checkedAt = 0L
  private var offered = false

  /** Downloaded and checked, waiting for the permission to install apps. */
  private var waiting: File? = null

  /** On launch and on coming back: look for a newer version, at most every few hours, and offer it once. */
  fun check() {
    waiting?.let {
      if (activity.packageManager.canRequestPackageInstalls()) {
        waiting = null
        install(it)
      }
    }
    if (BuildConfig.DEBUG || offered) return
    val now = SystemClock.elapsedRealtime()
    if (checkedAt != 0L && now - checkedAt < CHECK_EVERY) return
    checkedAt = now
    thread {
      val release = runCatching { latest() }.getOrNull() ?: return@thread
      activity.runOnUiThread { offer(release) }
    }
  }

  private fun offer(release: Release) {
    if (offered || activity.isFinishing || activity.isDestroyed) return
    offered = true
    AlertDialog
      .Builder(activity)
      .setTitle(R.string.update_title)
      .setMessage(activity.getString(R.string.update_message, release.versionName))
      .setPositiveButton(R.string.update) { _, _ -> fetch(release) }
      .setNegativeButton(R.string.later, null)
      .show()
  }

  private fun fetch(release: Release) {
    Toast.makeText(activity, R.string.update_downloading, Toast.LENGTH_SHORT).show()
    thread {
      val file = runCatching { download(release) }.getOrNull()
      activity.runOnUiThread {
        if (file == null) {
          Toast.makeText(activity, R.string.update_failed, Toast.LENGTH_SHORT).show()
        } else if (activity.packageManager.canRequestPackageInstalls()) {
          install(file)
        } else {
          // Android asks once per app: 允许安装未知应用. Coming back here (check) carries on.
          waiting = file
          Toast.makeText(activity, R.string.update_allow, Toast.LENGTH_LONG).show()
          activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${activity.packageName}".toUri()))
        }
      }
    }
  }

  private fun install(file: File) {
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", file)
    activity.startActivity(
      Intent(Intent.ACTION_VIEW).setDataAndType(uri, APK).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
    )
  }

  /** The published release when it is newer than this app; null when it is not, or the manifest is missing or odd. */
  private fun latest(): Release? {
    val json = JSONObject(String(get(URL("${site.scheme}://${site.authority}/downloads/android.json"), MANIFEST_LIMIT)))
    if (json.optInt("version") != 1) return null
    val code = json.getLong("versionCode")
    if (code <= BuildConfig.VERSION_CODE) return null
    val url = URL(URL("${site.scheme}://${site.authority}/"), json.getString("url"))
    // Only this site's own downloads, over the site's own scheme.
    if (url.protocol != site.scheme || url.authority != site.authority || !url.path.startsWith("/downloads/") || !url.path.endsWith(".apk")) return null
    val size = json.getLong("size")
    val sha256 = json.getString("sha256").lowercase()
    if (size <= 0 || size > APK_LIMIT || !SHA256.matches(sha256)) return null
    return Release(code, json.getString("versionName"), url, size, sha256)
  }

  /** Fetches the APK into the cache and keeps it only when it is exactly what was published, for this app. */
  private fun download(release: Release): File {
    val folder = File(activity.cacheDir, "updates").apply { mkdirs() }
    folder.listFiles()?.forEach { it.delete() }
    val file = File(folder, "anonhub-${release.versionCode}.apk")
    val bytes = get(release.url, release.size)
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    check(bytes.size.toLong() == release.size && digest == release.sha256) { "not the published file" }
    file.writeBytes(bytes)
    check(sameApp(file, release.versionCode)) { "not this app" }
    return file
  }

  /** The APK is this app at the promised version, signed with this app's key (the installer refuses another key too). */
  @Suppress("DEPRECATION")
  private fun sameApp(file: File, versionCode: Long): Boolean {
    val packages = activity.packageManager
    val archive = packages.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: return false
    if (archive.packageName != activity.packageName || archive.longVersionCode != versionCode) return false
    val theirs = archive.signingInfo?.apkContentsSigners ?: return true
    val mine = packages.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo?.apkContentsSigners ?: return true
    return theirs.map { it.toCharsString() }.toSet() == mine.map { it.toCharsString() }.toSet()
  }

  /** A GET with the WebView's user agent (the site's edge turns away bare clients), at most `limit` bytes. */
  private fun get(url: URL, limit: Long): ByteArray {
    val connection = url.openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 15_000
      connection.readTimeout = 30_000
      connection.useCaches = false
      connection.setRequestProperty("User-Agent", userAgent)
      connection.setRequestProperty("Cache-Control", "no-cache")
      check(connection.responseCode == HttpURLConnection.HTTP_OK) { "HTTP ${connection.responseCode}" }
      return connection.inputStream.use { input ->
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          out.write(buffer, 0, read)
          check(out.size() <= limit) { "too large" }
        }
        out.toByteArray()
      }
    } finally {
      connection.disconnect()
    }
  }

  private companion object {
    const val APK = "application/vnd.android.package-archive"
    const val CHECK_EVERY = 6 * 60 * 60 * 1000L
    const val MANIFEST_LIMIT = 64 * 1024L
    const val APK_LIMIT = 64 * 1024 * 1024L
    val SHA256 = Regex("[0-9a-f]{64}")
  }
}
