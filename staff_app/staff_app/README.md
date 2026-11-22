# Staff app (Flutter): jefe + repartidor

One app, one codebase (iOS + Android). The account role returned by the API decides the interface.
Jefe side: Spanish only. Repartidor side: Spanish / English (menu top right).
Ratings (client score + comment) are visible to every staff member: a tab for the jefe, a star icon for repartidores.

## Set up
1. `flutter create --org com.example --project-name staff_app staff_tmp`
2. Copy `lib/` and `pubspec.yaml` from this folder over `staff_tmp`, then `cd staff_tmp && flutter pub get`
3. Run against the backend:  `flutter run --dart-define=API_BASE=http://<your-pc-ip>:3000`
   (Android emulator: the default `http://10.0.2.2:3000` already works.)

## Platform notes
- Android, plain `http` in development: add `android:usesCleartextTraffic="true"` to `<application>` in
  `AndroidManifest.xml`. In production use HTTPS.
- Android 11+: add to `<manifest>` so maps/phone links open:
  `<queries><intent><action android:name="android.intent.action.VIEW"/><data android:scheme="https"/></intent>`
  `<intent><action android:name="android.intent.action.DIAL"/><data android:scheme="tel"/></intent></queries>`
- iOS: in `Info.plist` add `LSApplicationQueriesSchemes` with `https` and `tel`.

## Screens
Jefe: Pedidos (live list by status, ready / assign / reassign / cancel with reason / reprint, manual order),
      Repartidores (open / close shift with change given, live status), Caja (shift summary + settlement).
Repartidor: status banner, "LISTO PARA REPARTIR" (only while coming back), assigned orders with map / call /
      edit address / delivered (with confirmation), my shift summary (card payments listed one by one).

## Push notifications (Firebase Cloud Messaging)
The app works without them (it polls every 5 s). To turn them on:
1. Create a Firebase project. In your Flutter project run `dart pub global activate flutterfire_cli`
   then `flutterfire configure` (adds google-services.json / GoogleService-Info.plist and the Gradle plugin).
2. Android manifest, inside `<application>`:
   `<meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="orders"/>`
   and inside `<manifest>`: `<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>`
3. iOS: in Xcode enable the *Push Notifications* capability and *Background Modes > Remote notifications*,
   and upload an APNs key (.p8) in Firebase > Project settings > Cloud Messaging (needs the paid Apple developer account).
4. Backend: Firebase > Project settings > Service accounts > Generate new private key, paste the JSON on one line
   into `FIREBASE_SERVICE_ACCOUNT_JSON`, then run `npx prisma db push` (new `DeviceToken` table).

Who gets what: jefe = new order; repartidor = order assigned, reassigned away from him, or cancelled.
Texts are sent in the user's language. Tokens are removed on logout and when Firebase says they are dead.

## Not in this first version
A loud repeating alarm (push uses the system's default notification sound),
route order suggestion, offline mode.
