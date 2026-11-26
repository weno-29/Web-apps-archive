# AutoMix Studio（ブラウザ完結版）

Logic Pro などのDAWから書き出したステムを、ブラウザの中だけで自動ミックスするWebアプリです。
音声ファイルはどこにも送信されません（Web Audio APIで端末内処理）。

**使う:** https://weno-29.github.io/Web-apps-archive/automix-studio/

## 使い方
1. Logic Pro で「ファイル → 書き出す → すべてのトラックをオーディオファイルとして」（WAV 24-bit、ノーマライズOFF、オートメーションOFF推奨）
2. ページを開いてステムをドロップ（スマホはタップして選択）
3. 役割の自動判定（日本語ファイル名対応）を確認・修正
4. ジャンル / ラウドネス（−14 LUFS 配信向け・−9 LUFS デモ向け）/ ボーカル優先度を選んで「自動ミックスを実行」
5. mixed_master.wav（24-bit）・mixed_master.mp3（320 kbps）・mix_report.md・settings.json・processed_stems.zip をダウンロード

## エンジン
ゲインステージング（役割別ピーク目標）→ 役割別HPF/EQ/コンプ/パン → drums・music・vocal の3バス（バスコンプ）
→ グルーコンプ → tanhサチュレーション → BS.1770 K特性＋ゲーティングによる統合ラウドネス測定
→ 5 msルックアヘッドリミッタ（−1.5 dBFS天井）で目標LUFSへ反復収束。

## 制約
- AIFF / ALAC のデコードはブラウザ依存（Safariは可、ChromeはWAV推奨）
- 目安 〜16ステム / 〜8分（端末メモリ次第）
- ピーク表示はサンプル補間による近似値
- MP3エンコードは lamejs（CDN）を使用。読み込めない環境ではWAVのみ
