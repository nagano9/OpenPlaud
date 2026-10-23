# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# OkHttp's optional TLS providers (not used on Android).
-dontwarn org.bouncycastle.jsse.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**

# The Tauri plugin and its Bluetooth services are reached by reflection (@Command, @TauriPlugin)
# and from the manifest; BouncyCastle registers its algorithms by name.
-keep class com.openplod.vault.** { *; }
-keep class org.bouncycastle.** { *; }
# BouncyCastle's LDAP certificate store, which Android does not have.
-dontwarn javax.naming.**
