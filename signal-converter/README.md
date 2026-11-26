# Signal Converter

文書・音声・動画・画像・データの拡張子をブラウザ内で変換するウェブアプリです。ファイルは外部に送信されません。

## 対応変換

| 系統 | 入力 | 出力 |
|---|---|---|
| 画像 | png jpg webp gif bmp | png jpg webp bmp |
| 音声 | mp3 wav ogg m4a flac | wav mp3 |
| 動画 | mp4 webm mov | webm（対応環境ではmp4）、音声抽出 wav / mp3 |
| 文書 | docx | html md txt pdf |
| 文書 | pdf | txt md |
| 文書 | md txt html | md txt html pdf |
| データ | csv xlsx json | csv xlsx json html |

## 書籍原稿の変換について

DOCX / Markdown → PDF は、見出し・表・箇条書き・段落・改行をそのまま組版し、段落や表の途中で改ページしません。本文の内容には手を加えません。

## 制約

- PDF出力は画像ベースのため、文字の選択・検索はできません（KDPの本文入稿にはWordからの直接書き出しを推奨）
- 動画変換は再生しながら録画する方式のため、動画の長さと同じくらいの時間がかかります
- スキャンPDF（画像のみ）からはテキストを抽出できません
