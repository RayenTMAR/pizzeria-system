/// Run with: flutter run --dart-define=API_BASE=https://your-server.com
/// 10.0.2.2 is the host machine as seen from the Android emulator.
const apiBase = String.fromEnvironment('API_BASE', defaultValue: 'http://10.0.2.2:3000');
