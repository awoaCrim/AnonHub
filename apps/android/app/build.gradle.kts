import java.util.Properties

plugins {
  id("com.android.application")
}

// The release key stays on the machine that publishes, never in the repository (like the device client's signing key).
val releaseKey =
  file("${System.getProperty("user.home")}/.config/yesimbot/android-release.properties").takeIf { it.isFile }?.let { source ->
    Properties().apply { source.inputStream().use(::load) }
  }

android {
  namespace = "com.uwoacrimson.yesimbot"
  compileSdk = 37

  defaultConfig {
    applicationId = "com.uwoacrimson.yesimbot"
    minSdk = 29
    targetSdk = 36
    versionCode = 4
    versionName = "1.3"
    buildConfigField("String", "SITE_URL", "\"${providers.gradleProperty("yesimbotSite").get()}\"")
  }

  buildFeatures {
    buildConfig = true
  }

  signingConfigs {
    if (releaseKey != null) {
      create("release") {
        storeFile = file(releaseKey.getProperty("storeFile"))
        storePassword = releaseKey.getProperty("storePassword")
        keyAlias = releaseKey.getProperty("keyAlias")
        keyPassword = releaseKey.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    debug {
      applicationIdSuffix = ".debug"
      versionNameSuffix = "-debug"
    }
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
      signingConfig = signingConfigs.findByName("release")
    }
  }
}

dependencies {
  implementation("androidx.activity:activity:1.13.0")
  implementation("androidx.core:core:1.19.1")
  implementation("androidx.webkit:webkit:1.18.0")
}
