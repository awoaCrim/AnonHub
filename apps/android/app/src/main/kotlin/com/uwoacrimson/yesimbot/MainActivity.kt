package com.uwoacrimson.yesimbot

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.graphics.drawable.toDrawable
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The phone app: the YesImBot site (web chat and console) in one full-screen WebView. The site's own pages load here;
 * every other address opens in the phone's browser, which also keeps Google sign-in out of the WebView (Google refuses
 * it there).
 */
class MainActivity : ComponentActivity() {
  private val site: Uri = BuildConfig.SITE_URL.toUri()
  private val origin = "${site.scheme}://${site.authority}"
  private lateinit var root: View
  private lateinit var web: WebView
  private lateinit var offline: View
  private var choosing: ValueCallback<Array<Uri>>? = null
  private lateinit var updater: Updater

  private val chooseFiles =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      choosing?.onReceiveValue(if (result.resultCode == RESULT_OK) chosen(result.data) else null)
      choosing = null
    }

  /** Back walks the page's history; with none left it leaves the app as usual (and the system can animate it). */
  private val back =
    object : OnBackPressedCallback(false) {
      override fun handleOnBackPressed() = web.goBack()
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    window.isNavigationBarContrastEnforced = false
    setContentView(R.layout.main)
    root = findViewById(R.id.root)
    web = findViewById(R.id.web)
    offline = findViewById(R.id.offline)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    findViewById<View>(R.id.retry).setOnClickListener { web.reload() }
    onBackPressedDispatcher.addCallback(this, back)
    setUp()
    updater = Updater(this, site, web.settings.userAgentString)
    if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(site.toString())
  }

  override fun onResume() {
    super.onResume()
    web.onResume()
    updater.check()
  }

  override fun onPause() {
    web.onPause()
    CookieManager.getInstance().flush()
    super.onPause()
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    web.saveState(outState)
  }

  override fun onDestroy() {
    web.destroy()
    super.onDestroy()
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun setUp() {
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    web.setBackgroundColor(getColor(R.color.page))
    web.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      userAgentString = "$userAgentString YesImBotApp/${BuildConfig.VERSION_NAME}"
    }
    // page.js talks only through this listener, so it runs only where the listener exists.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.addWebMessageListener(web, "YesImBotApp", setOf(origin)) { _, message, _, isMainFrame, _ ->
        if (isMainFrame) message.data?.let(::received)
      }
      if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
        WebViewCompat.addDocumentStartJavaScript(web, assets.open("page.js").bufferedReader().use { it.readText() }, setOf(origin))
      }
    }
    web.webViewClient =
      object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
          if (!request.isForMainFrame || onSite(request.url)) return false
          openOutside(request.url)
          return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
          offline.visibility = View.GONE
          web.visibility = View.VISIBLE
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
          if (!request.isForMainFrame) return
          web.visibility = View.INVISIBLE
          offline.visibility = View.VISIBLE
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
          back.isEnabled = view.canGoBack()
        }

        // The page's renderer was killed (for memory, usually in the background) or crashed: open the site again.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
          finish()
          startActivity(Intent(this@MainActivity, MainActivity::class.java))
          return true
        }
      }
    web.webChromeClient =
      object : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
          choosing?.onReceiveValue(null)
          val types = mimeTypes(params.acceptTypes)
          val intent = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType(types.singleOrNull() ?: "*/*")
          if (types.size > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
          if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
          return try {
            chooseFiles.launch(intent)
            choosing = callback
            true
          } catch (_: ActivityNotFoundException) {
            choosing = null
            false
          }
        }
      }
    web.setDownloadListener { url, userAgent, disposition, mimeType, _ ->
      val uri = url.toUri()
      when {
        // page.js saves these.
        uri.scheme == "blob" || uri.scheme == "data" -> Unit
        !onSite(uri) -> openOutside(uri)
        else -> download(uri, userAgent, disposition, mimeType)
      }
    }
  }

  private fun received(text: String) {
    val message = runCatching { JSONObject(text) }.getOrNull() ?: return
    when (message.optString("type")) {
      "theme" -> cssColor(message.optString("background"))?.let { paintBars(it, message.optBoolean("dark")) }
      "save" -> {
        val name = message.optString("name")
        val data = message.optString("data")
        thread { save(name, data) }
      }
    }
  }

  /** The window shows through the root's padding, so its colour is what fills the status and navigation bars. */
  private fun paintBars(color: Int, dark: Boolean) {
    window.setBackgroundDrawable(color.toDrawable())
    WindowCompat.getInsetsController(window, root).apply {
      isAppearanceLightStatusBars = !dark
      isAppearanceLightNavigationBars = !dark
    }
  }

  /** A file the site serves: DownloadManager fetches it with this session's cookies and shows its progress. */
  private fun download(uri: Uri, userAgent: String, disposition: String?, mimeType: String?) {
    val name = URLUtil.guessFileName(uri.toString(), disposition, mimeType)
    val request =
      DownloadManager
        .Request(uri)
        .setMimeType(mimeType)
        .addRequestHeader("User-Agent", userAgent)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
    CookieManager.getInstance().getCookie(uri.toString())?.let { request.addRequestHeader("Cookie", it) }
    getSystemService(DownloadManager::class.java).enqueue(request)
    Toast.makeText(this, getString(R.string.downloading, name), Toast.LENGTH_SHORT).show()
  }

  /** Saves a `data:` URL from page.js into 下载. Runs off the main thread. */
  private fun save(name: String, data: String) {
    val comma = data.indexOf(',')
    val head = if (data.startsWith("data:") && comma > 0) data.substring(5, comma) else ""
    val saved =
      head.endsWith(";base64") &&
        runCatching {
          val mime = head.removeSuffix(";base64").ifEmpty { "application/octet-stream" }
          val bytes = Base64.decode(data.substring(comma + 1), Base64.DEFAULT)
          val file = fileName(name, mime)
          val values =
            ContentValues().apply {
              put(MediaStore.Downloads.DISPLAY_NAME, file)
              put(MediaStore.Downloads.MIME_TYPE, mime)
              put(MediaStore.Downloads.IS_PENDING, 1)
            }
          val item = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
          contentResolver.openOutputStream(item)!!.use { it.write(bytes) }
          contentResolver.update(item, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
          file
        }.onSuccess { file -> runOnUiThread { Toast.makeText(this, getString(R.string.saved, file), Toast.LENGTH_SHORT).show() } }
          .isSuccess
    if (!saved) runOnUiThread { Toast.makeText(this, R.string.save_failed, Toast.LENGTH_SHORT).show() }
  }

  private fun onSite(uri: Uri) = uri.scheme == site.scheme && uri.authority == site.authority

  private fun openOutside(uri: Uri) {
    try {
      startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
    } catch (_: ActivityNotFoundException) {
      // Nothing on the phone opens this kind of address.
    }
  }

  private fun chosen(data: Intent?): Array<Uri>? {
    val clip = data?.clipData ?: return data?.data?.let { arrayOf(it) }
    return Array(clip.itemCount) { clip.getItemAt(it).uri }
  }

  private companion object {
    val RGB = Regex("""rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)""")

    /** `accept` of an `<input type=file>` as MIME types; extensions are looked up, unknown ones dropped. */
    fun mimeTypes(accept: Array<String>): List<String> =
      accept
        .flatMap { it.split(',') }
        .map { it.trim().lowercase() }
        .filter { it.isNotEmpty() }
        .mapNotNull { if (it.startsWith('.')) MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.substring(1)) else it }
        .distinct()

    /** `rgb(…)` / `rgba(…)` as getComputedStyle reports it; null when see-through or unreadable. */
    fun cssColor(value: String): Int? {
      val match = RGB.matchEntire(value.trim()) ?: return null
      val alpha = match.groupValues[4]
      if (alpha == "0" || alpha == "0%") return null
      val (red, green, blue) = match.groupValues.drop(1).take(3).map { it.toInt().coerceIn(0, 255) }
      return Color.rgb(red, green, blue)
    }

    /** The page's file name, without path separators or control characters, ending in the type's extension. */
    fun fileName(name: String, mime: String): String {
      val clean = name.replace(Regex("""[\u0000-\u001f\u007f/\\]"""), "_").trim().trimEnd('.', ' ').take(120)
      val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
      val base = clean.ifEmpty { "YesImBot-${System.currentTimeMillis()}" }
      return if (extension == null || base.lowercase().endsWith(".$extension")) base else "$base.$extension"
    }
  }
}
