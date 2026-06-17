/**
 * QR Check-In Pro - Firebase Configuration
 *
 * Hướng dẫn:
 * 1. Vào https://console.firebase.google.com
 * 2. Tạo project mới (miễn phí)
 * 3. Vào Project Settings → General → Your apps → Web app
 * 4. Copy firebaseConfig bên dưới và thay thế các giá trị
 * 5. Vào Firestore Database → Create database (chọn test mode)
 *
 * ⚠️ LƯU Ý: Firebase chỉ hoạt động khi deploy lên HTTP/HTTPS server.
 *    Nếu mở file trực tiếp (file://) sẽ tự động dùng Local mode.
 */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC2EXzs31QlRJg7wq6oasoUeivY8OgLOZE",
  authDomain: "qr-test-2330d.firebaseapp.com",
  projectId: "qr-test-2330d",
  storageBucket: "qr-test-2330d.firebasestorage.app",
  messagingSenderId: "924364338498",
  appId: "1:924364338498:web:308397e29f2bc0eeddc4db"
};

// ⚠️ Firebase KHÔNG hoạt động khi mở file trực tiếp (file://)
// Chỉ bật khi chạy từ HTTP server (localhost, Vercel, v.v.)
const _isHttpServer = location.protocol === 'http:' || location.protocol === 'https:';
const _hasKeys = FIREBASE_CONFIG.apiKey !== "" && FIREBASE_CONFIG.projectId !== "";

// Kiểm tra xem Firebase đã được cấu hình chưa
const IS_FIREBASE_CONFIGURED = _hasKeys && _isHttpServer;

// Export config
window.FIREBASE_CONFIG = FIREBASE_CONFIG;
window.IS_FIREBASE_CONFIGURED = IS_FIREBASE_CONFIGURED;

// Cảnh báo sớm nếu có key nhưng đang dùng file://
if (_hasKeys && !_isHttpServer) {
  console.warn('[QR App] Firebase keys đã nhập nhưng đang chạy từ file://. Sẽ dùng Local mode. Deploy lên HTTP server để dùng Firebase.');
}
