import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'api.dart';

/// Bumped when a push arrives while the app is open, so the screens refresh at once.
final pushTick = ValueNotifier<int>(0);

class Push {
  static Future<void>? _init;
  static bool _ready = false;
  static String? _token;

  /// Safe to call many times. If Firebase is not configured the app keeps working (polling only).
  static Future<void> init() => _init ??= _doInit();

  static Future<void> _doInit() async {
    try {
      await Firebase.initializeApp();
      final fm = FirebaseMessaging.instance;
      await fm.requestPermission(alert: true, badge: true, sound: true);

      if (Platform.isAndroid) {
        // High-importance channel: the backend sends every push to channel "orders"
        await FlutterLocalNotificationsPlugin()
            .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
            ?.createNotificationChannel(const AndroidNotificationChannel(
              'orders',
              'Pedidos / Orders',
              description: 'New orders and assignments',
              importance: Importance.max,
              playSound: true,
            ));
      }
      // iOS: show the banner and play the sound even while the app is open
      await fm.setForegroundNotificationPresentationOptions(alert: true, badge: true, sound: true);

      FirebaseMessaging.onMessage.listen((_) => pushTick.value++);
      fm.onTokenRefresh.listen((t) {
        _token = t;
        _send(t);
      });
      _ready = true;
    } catch (e) {
      debugPrint('Push disabled: $e');
    }
  }

  /// Call after login (and when the app starts already logged in).
  static Future<void> register() async {
    await init();
    if (!_ready) return;
    try {
      _token = await FirebaseMessaging.instance.getToken();
      if (_token != null) await _send(_token!);
    } catch (e) {
      debugPrint('Push register failed: $e');
    }
  }

  /// Call BEFORE clearing the session, so this phone stops getting the user's notifications.
  static Future<void> unregister() async {
    final t = _token;
    if (t == null) return;
    try {
      await Api.post('/me/device/remove', {'token': t});
    } catch (_) {}
  }

  static Future<void> _send(String t) async {
    if (Api.token == null) return;
    try {
      await Api.post('/me/device', {'token': t, 'platform': Platform.isIOS ? 'ios' : 'android'});
    } catch (_) {}
  }
}
