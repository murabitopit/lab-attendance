// 研究室 出席管理の Firebase 設定ファイル。
//
// 【初回設定手順】(詳しくは README.md)
// 1. https://console.firebase.google.com/ で無料のプロジェクトを新規作成(例:lab-attendance)
//    ※ 資産管理アプリのプロジェクトとは分けること(研究室のみんなが読み書きするため)
// 2. 「構築」→「Firestore Database」→「データベースの作成」→ ロケーション asia-northeast1(東京)→ 本番環境モード
// 3. 「ルール」タブに firestore.rules の内容を貼り付けて「公開」
// 4. 「構築」→「Authentication」→「Sign-in method」で「匿名」を有効化
// 5. 歯車 →「プロジェクトの設定」→「マイアプリ」の「</>」でウェブアプリを登録し、
//    表示された firebaseConfig の中身を下にコピー
//
// ここに書く値は Web アプリでは公開されて問題ない情報(アクセス制御は firestore.rules 側で行う)。
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyB4A9Cq1yks7FiNeH1cJP7UGw8PI6y_IHg",
  authDomain: "lab-attendance-5c916.firebaseapp.com",
  projectId: "lab-attendance-5c916",
  storageBucket: "lab-attendance-5c916.firebasestorage.app",
  messagingSenderId: "1646383553",
  appId: "1:1646383553:web:f17e2e84dab54f6a655f40"
};
