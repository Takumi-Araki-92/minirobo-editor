# フリート開発者向け — 連携セットと展示モード（r13）

本ツールはマップ・予定シーケンス・初期位置の準備と、モニター上の展示再生を担当します。
中間ファイルの種類、実機通信、実行管理、安全管理はフリート側で自由に設計してください。
以下のJSONとローカルHTTPは、特定のフリート製品に依存しない参照実装です。
**展示開始APIは実機を動かしません。展示時間軸の再生だけです。**
全体仕様は[AI_HANDOFF](AI_HANDOFF.md)を参照してください。

## 1. まず開ける受け渡しサンプル

[fleet-bundle.example.json](fleet-bundle.example.json)に、日常運用1〜3のマップ・
ナビゲーション・各ロボットの初期位置・時刻付き動作をセットで同梱しています。
架空の標準テンプレートから生成した例で、利用者の作業マップや履歴ではありません。

| index | サンプル |
|---|---|
| 1 | 日常運用1：夜間警備巡回 |
| 2 | 日常運用2：夜間清掃 |
| 3 | 日常運用3：荷物受取・扉通過・EV乗車 |

これをCSV、独自JSON、DB、メッセージ等へ変換するかは連携先が決められます。
サンプルファイルは展示画面に自動登録されません。展示画面の現在セットは下記APIから取得します。
事前保存したセットと展示登録時のセットは別のbundle_idになります。
APIで指示するときは、必ず現在のGET /api/fleetが返すbundle_idを使ってください。

### 利用者が作ったプロジェクトを渡す

画面下の「シーケンス設定・デモ・連携」→「フリート連携セットを保存」で、
**現在プロジェクトの全タブ**を1ファイルに出力します。
現在タブだけを出す既存の「連携用JSON（予定）」とは別です。
全タブの実行可能性を検証し、実行不可・blockedのシナリオも動作を省略せず含めます。
その項目は`executable:false`、理由を`validation.errors`へ付け、
成功した予定を作れない`scenario_draft`は明示的にnullにします。展示でそのindexの選択は拒否しますが、
他の正常なindexは利用できます。スキーマ自体が不正なプロジェクトは生成を拒否します。
接触やstoryの施錠通過など、停止を伴わないwarningsは出力に残ります。安全承認ではありません。

CLIでも同じ形式を生成できます。出力先が既に存在する場合は上書きしません。

```powershell
# 標準の日常運用3本
node .\scripts\export-fleet-bundle.js .\sample-output.json
# 保存済みプロジェクトから（入力自体は変更しない）
node .\scripts\export-fleet-bundle.js .\handoff-output.json .\my-project.json
```

## 2. 連携セットの形式

スキーマは`scene-fleet-bundle/v1`。
`bundle_id`は生成ごとのUUID、indexはそのセット内で1始まりです。
編集中の並べ替えで既存セットを更新せず、展示中も開始時のスナップショットを使います。
再生成・再入場では新しいbundle_idになるため、**index単独ではなくbundle_idと組で管理**します。

```text
bundle
  schema / bundle_id / project_name / index_base: 1
  simulation_only: true / hardware_approved: false
  coordinates                         単位・座標の説明
  scenarios[]
    index / map_id / name / duration_s
    executable / validation.errors / validation.warnings
    map                               演出・背景・全行を含む完全なマップ定義
    navigation                        セル・壁・開口・家具占有
    robots[]
      track_id / robot_id / name / role
      initial                         x / y / yaw / roomId / coordinateMode
      sequence[]                      時間軸で計画したロボット動作
        action_id / track_id / robot_id / name / type
        start_s / end_s
        from / to                     該当する移動・旋回のみ
        executable / reason           実行可否・停止理由
        raw_action                    元のアクション全フィールド
        room_id / door_id / event / text  該当フィールドのみ
    scenario_draft                    既存scene-scenario-draft/v1
```

`robots`には除外されていないロボットだけを含みます。
`map.tracks`には人物・部屋・画面表示・除外行を含む編集上の全行が残ります。
人物・建物イベントと扉解錠等の全予定は`scenario_draft.actions`で確認できます。
動作間の空白も予定時間なので、詰めずに扱ってください。
sequenceのstart_s/end_sは宣言されたバー時刻で、blockedでも元の全動作を保持します。
不成立のfromは捏造せず省略し、指定された目標toとraw_actionを残します。
実機が予定時刻に間に合う保証・動的な完了待ち・実機結果注入はありません。

### 座標と単位（重要）

| 場所 | 単位・原点 |
|---|---|
| robots.initial | 1600×900、左下原点・X右・Y上。角度フィールドは`yaw` |
| robots.sequence.from/to | 同じ1600×900、角度フィールドは`yaw_deg` |
| map内のアクター座標・presentation | 同じ1600×900、左下原点・Y上 |
| navigation | 同じ1600×900、Y上。セル番号だけ左上起点 |
| scenario_draftのinitial/from/to | **百分率0〜100、Y上**。既存の予定出力形式 |
| 元mapの独立壁・独立ドアの線分 | **SVG側の左上原点・Y下**。外部連携では変換済みnavigationを推奨 |

yawは右0°・反時計回り正・(-180,180]。これらは実寸mm・カメラ画像pxではありません。
`robot_id`は実機ID候補で、`track_id` UUIDやindexとは別です。
マップごとにロボットID・実測フィールド・変換・許可範囲を確認してください。

## 3. 展示モードの操作

1. 展示するマップをプロジェクトのタブとして用意する（最大8）。
2. 必要ならJSON保存で現作業を退避し、エラーを修正する。
3. プレビュー右下の「展示モード」を押す。
4. ロボット表示を隠して全画面になり、現在マップの時刻0で**フリート指示待ち**になる。
5. フリート側は現在のカタログとbundleを取得し、indexをselectする。
6. 指定マップへ切り替わり、時刻0で**開始指示待ち**になる。
7. startで展示の人物・扉・部屋イベント・汚れ等の時間軸を再生する。

非表示にするのはロボット本体・ラベル・ロボット追従表示・編集枠・予定経路です。
シナリオ演出のroute cueも展示中は隠します。
人物、床・壁・扉、部屋の作業表示、汚れ・混雑・火災・通知等は残します。
ロボットの**データ・位置計算・扉反応・安全予測は削除しません**。
実機の進捗で扉・演出を動かす機能ではなく、予定時間軸での表示です。
通常の「全画面」は従来どおりロボットを表示します。

展示中のローカル再生・シーク・速度・ループは無効化し、フリート指示で統一します。
再生速度は1倍・ループなし。マウス等で透過操作バーが現れ、待機状態とindexを確認できます。
Escまたは「全画面を終了」で展示セッションを終え、元のタブ・再生位置・通常表示へ戻ります。
編集JSON・Undo/Redo・履歴は増やしません。元の再生は自動再開しません。
展示を続ける間はブラウザーを前面で表示し、PCのスリープを避けてください。
全画面API拒否時は理由を表示して画面内最大化します。

## 4. 同一PC用HTTP API

既定ベースURL: `http://localhost:3100`。
127.0.0.1にだけ待ち受け、LAN公開・CORS・外部認証は追加しません。
別PCから呼ぶ場合は、フリート側のアダプター／認証・配備設計を別途行ってください。
ブラウザーからの別オリジンアクセスは拒否します。同一PCのサーバー側HTTPクライアントを想定します。
ローカルプロセス同士を認証・権限分離するAPIではありません。信頼できるPCで利用します。

| メソッド・パス | 内容 |
|---|---|
| GET /api/fleet | ready、mode、bundle_id、selected_index、time_s、カタログ、指示の受領状況 |
| GET /api/fleet/bundle | 現在セット全部 |
| GET /api/fleet/scenarios/1 | 指定indexのマップ＋robots初期位置・sequence等（bundle_id付き） |
| POST /api/fleet/commands | select/start/pause/reset |
| POST /api/fleet/session | 展示ブラウザー専用。projectからセットを登録、client_tokenを返す |
| POST /api/fleet/heartbeat | 展示ブラウザー専用。状態送信、指示受信、適用確認 |
| POST /api/fleet/end | 展示ブラウザー専用。セッション終了 |

POSTはContent-Typeを厳密に`application/json`とし、ボディは100MiB以下。
画面が未接続ならready=false。展示画面は約250msごとに状態と受領確認を送信します。
10秒以上応答がないとready=falseになり、そのセッションの古い指示を再接続で実行しません。
画面の通信エラー時は再生を停止し、理由を表示します。展示を終了して入り直してください。
サーバー再起動でもセッションは失われます。セットはメモリー内で、履歴には保存しません。
終了・タイムアウト後も最後のbundleを取得できますが、ready=falseなら指示できません。

### 4.1 指示と適用確認

```json
{
  "id": "unique-command-id",
  "bundle_id": "GET /api/fleetで得たbundle_id",
  "type": "select",
  "index": 2
}
```

- idは1〜80文字の英数字・`_`・`-`。原則、指示ごとに新規UUIDを使います。
- selectは有効な1始まりindexが必須。start/pause/resetにはindexを付けません。
- select: 指定マップへ切替・時刻0・一時停止。再生は始めません。
- start: 選択済みシナリオの再生／再開。終端なら時刻0から再生します。
- pause: 一時停止。reset: 時刻0へ戻し、開始指示待ちへ戻します。
- 未選択でstart等を送る、不明index、古いbundle_idは拒否します。
  executable=falseのindexは422と理由を返し、元マップを切り替えません。
- 一度に保留できる指示は1件。前指示の適用確認後に次を送ります。
- HTTP202 `{id,status:"accepted"}`は受付だけで、画面への適用完了ではありません。
  GET /api/fleetのlast_commandが同じidで`status:"applied"`になるまで待ちます。
  画面適用失敗は`status:"failed", error`です。受付成功を実機到着成功と混同しません。
- 保留中または直近確認済みの同一id・同一内容の再送は重複適用しません。
  同じidで内容を変えると409。古いidを別の新指示へ使い回さないでください。
- 応答待ち中はpending_commandを確認し、タイムアウト・offline・failedなら自動で
  「成功」にせず、連携先で中止・再入場等を判断してください。

ready=trueは展示ブラウザーの接続状態を示し、ロボット・設備の安全確認ではありません。
modeは`offline/waiting/selected/running/paused/finished`。
time_sは最後に画面が報告した模擬相対時刻で、実測・同期時計ではありません。

### 4.2 PowerShellの呼出し例

展示モードを画面で開始してから実行します。

```powershell
$base = 'http://localhost:3100'
$status = Invoke-RestMethod "$base/api/fleet"
if (-not $status.ready) { throw '展示モードが待機していません' }
$status.scenarios | Format-Table index, name, map_id
$bundle = Invoke-RestMethod "$base/api/fleet/bundle"
$scenario = Invoke-RestMethod "$base/api/fleet/scenarios/1"
# $scenario.navigation / $scenario.robots[].initial / $scenario.robots[].sequence

function Send-ExhibitionCommand {
    param([string]$Type, [Nullable[int]]$Index)
    $current = Invoke-RestMethod "$base/api/fleet"
    if (-not $current.ready -or $current.bundle_id -ne $bundle.bundle_id) {
        throw '展示セッションが変更または終了しました'
    }
    $id = [guid]::NewGuid().ToString()
    $body = @{ id = $id; bundle_id = $bundle.bundle_id; type = $Type }
    if ($null -ne $Index) { $body.index = [int]$Index }
    Invoke-RestMethod "$base/api/fleet/commands" -Method Post `
        -ContentType 'application/json' -Body ($body | ConvertTo-Json) | Out-Null
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $current = Invoke-RestMethod "$base/api/fleet"
        if (-not $current.ready -or $current.bundle_id -ne $bundle.bundle_id) {
            throw '展示画面との接続が失われました'
        }
        if ($current.last_command.id -eq $id) {
            if ($current.last_command.status -ne 'applied') {
                throw $current.last_command.error
            }
            return
        }
    } while ((Get-Date) -lt $deadline)
    throw '展示指示の適用確認がタイムアウトしました'
}

Send-ExhibitionCommand -Type select -Index 1
# ここでフリート側は初期位置・マップ・シーケンスを確認する
Send-ExhibitionCommand -Type start
# 必要時
Send-ExhibitionCommand -Type pause
Send-ExhibitionCommand -Type reset
```

フリート側から実機を始動する時点と、展示のstartを送る時点の整合は連携先が管理します。
本APIだけで実機と時刻同期するものではありません。

## 5. 更新・検証・復旧

r12→r13は**削除なし、新規7ファイル、既存11ファイルの更新**です。
簡単に適用する場合はZIP内のrobot-scene-studioの中身を上書きし、
既存のdataやユーザーJSONを削除しないでください。

- 新規: [連携サーバー](fleet-session.js)、[セット生成](public/fleet-bundle.js)、
  [モデル/APIテスト](test/fleet.test.js)、[展示UIテスト](browser-tests/fleet-exhibition.spec.js)、
  [生成CLI](scripts/export-fleet-bundle.js)、[サンプル](fleet-bundle.example.json)、本書。
- 更新: [server](server.js)、[app](public/app.js)、[HTML](public/index.html)、
  [CSS](public/style.css)、[予定出力](public/scenario-export.js)、
  [梱包](scripts/package.ps1)、[README](README.md)、[INTEGRATION](INTEGRATION.md)、
  [AI_HANDOFF](AI_HANDOFF.md)、[AGENTS](AGENTS.md)、
  [Copilot指示](.github/copilot-instructions.md)。

先に現作業JSON保存→サーバー正常停止→新版ソースへ更新→起動→ブラウザー再読込→
セット内容とindex確認→展示待機→select適用確認→start確認、の順で適用してください。
新しいJSの配信とAPIが必要なので、ブラウザー更新だけでなくサーバー再起動が必要です。
別の展示画面が接続中なら409で登録を拒否します。元画面を終了するか10秒の失効を待ちます。
実行不可のタブは検証結果付きで保持し、展示のカタログと操作バーにも示します。
そのindexのselectは拒否します。元シーケンスを勝手に修正・削除しません。

失敗時は展示を終了し、JSON・履歴を保全して旧版コードへ戻します。
既存プロジェクトの保存スキーマは変更しておらず、bundleは別形式です。
bundleを通常の「開く」へ投入せず、編集再開には元のプロジェクトJSONを使ってください。
履歴データの削除・初期化は不要です。

検証は[fleet.test.js](test/fleet.test.js)と
[fleet-exhibition.spec.js](browser-tests/fleet-exhibition.spec.js)にあります。
indexと初期位置・全動作の対応、単位、blocked拒否、JSON保存、APIのOrigin・入力・排他、
指示の適用確認・期限切れ、ロボットだけの非表示、人物・扉・汚れの保持、
通信エラー時停止、終了後の元作業復元を確認します。
