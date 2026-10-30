# MMS PDU encoder

The files under app/src/main/java/com/google/android/mms are the outbound PDU subset of android-smsmms, commit f6fa7d379444dc11d700fe6178b418bd76cfb88f:
https://github.com/klinker41/android-smsmms/tree/f6fa7d379444dc11d700fe6178b418bd76cfb88f/library/src/main/java/com/google/android/mms

Copyright notices remain in each source file. Licensed under Apache License 2.0 (LICENSE-APACHE-2.0.txt).
Local modifications: logger imports use android.util.Log; the unused SendReq.prepareFromAddress helper and its third-party Utils dependency were removed. The sender uses the standard insert-address token, allowing the selected SIM/carrier to provide the sending address.
