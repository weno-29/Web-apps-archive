# Weno AutoMix Engine v0.1 (Web)

完成イメージの **demo** と各 **stem** をブラウザで読み込むと、トラックごとの役割・音量・EQ・コンプ・パン・センドの推奨設定と、Logic Proで再現するためのメモを生成するツールです。

**解析はすべてブラウザ内で完結し、音声ファイルはどこにも送信されません。**

## 使い方

1. 公開ページを開く（GitHub Pages）
2. demo（参照用の2mix）を1本、stemsを複数選択（ドラッグ＆ドロップ可）
3. 「解析して推奨設定を作る」
4. 必要なら各トラックの役割（MAIN / FOUNDATION / CONTOUR / SUPPORT）を手動で変更 → 推奨値が再計算されます
5. `analysis_report.json` / `mix_settings.json` / `logic_notes.txt` をダウンロード

音源が手元になくても「サンプル音源で試す」で合成音源による動作確認ができます。

### 対応フォーマット

- WAV（PCM 8/16/24/32bit・float 32/64bit）— 元のサンプルレートのまま解析
- FLAC / MP3 / M4A など — ブラウザのデコーダ経由（48kHzに変換して解析）
- AIFF — Safariのみ

## 解析内容

| 項目 | 実装 |
|---|---|
| Integrated / Short-term LUFS | ITU-R BS.1770-4（K-weighting、400msブロック、-70 LUFS絶対ゲート、-10 LU相対ゲート） |
| True Peak | 4xオーバーサンプリング（Kaiser窓sinc補間） |
| RMS / Sample Peak | — |
| 帯域バランス | Low 20–250Hz / Mid 250–4kHz / High 4k–20kHz のエネルギー比 |
| スペクトル重心・トランジェント密度・ステレオ幅 | STFT / spectral flux / Side÷Mid |
| セクション推定（demoのみ） | 2秒窓ラウドネスとIntegratedの差による目安（サビ候補など） |
| マスキング指標 | stem間の平均スペクトルのコサイン類似度 |

役割はファイル名（vocal, bass, kick, Lead Gt, ボーカル…）から推定し、判別できない場合は音響特徴から推定します（確度「要確認」と表示）。

## 精度検証

Python版（同じ技術指示書に基づくCLI実装）と同一テスト音源で照合し、LUFS・RMS・Peak・帯域比・スペクトル重心・トランジェント密度・ステレオ幅は一致、True Peakは差0.03 dB以内でした。商用メーターとの突き合わせは未実施のため、納品用マスターの数値確認には専用メーターを併用してください。

## 構成

```
weno-automix/
  index.html
  css/style.css
  js/
    app.js             UI
    audio-loader.js    WAVパーサ / デコード
    analyzer.js        ラウドネス・スペクトル解析
    role-classifier.js 役割推定
    mix-engine.js      推奨設定の生成
    report-writer.js   JSON / Logic Proメモ出力
    worker.js          解析をWeb Workerで実行
    sample.js          サンプル音源生成
```

ビルド不要の静的サイトです。ES Modulesを使うため、ローカルで試す場合は `python3 -m http.server` などで配信してください（`file://` では動きません）。

## 既知の制約

- v0.1は**推奨値の生成のみ**。音声へのエフェクト適用・2mix書き出しは次段階（Phase 3）
- セクション推定・音響特徴による役割推定はヒューリスティックです
- 推奨値は出発点です。最終判断は必ずdemoと聴き比べて行ってください

---

Weno AutoMix Engine v0.1 · Weno-29
