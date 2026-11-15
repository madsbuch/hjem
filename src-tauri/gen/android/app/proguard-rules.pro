# ML Kit discovers component registrars by manifest name and constructs them
# through reflection. The scanner's older firebase-components rules preserve
# the classes but omit constructors, which R8 full mode can remove. That crashes
# BarcodeScanning.getClient() immediately after camera permission is granted.
# Match Firebase's current rule while keeping release optimization enabled:
# https://github.com/firebase/firebase-android-sdk/blob/main/firebase-components/proguard.txt
-keep class * implements com.google.firebase.components.ComponentRegistrar {
    void <init>();
}
-keep,allowshrinking interface com.google.firebase.components.ComponentRegistrar
