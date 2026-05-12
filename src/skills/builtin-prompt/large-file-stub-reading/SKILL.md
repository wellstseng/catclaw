description: Use when you see `[tool_result_externalized: ... 完整內容 @ /abs/path]` stub from a large file read — explains why DO NOT give up and how to use offset/limit/grep to actually retrieve content.

# 大檔外部化 Stub 讀取規範

當你看到 tool_result 被包成這種 stub：

```
[tool_result_externalized: read_file | /path/to/file.json | 175 行 / 175.0 KB | 完整內容 @ /abs/path/.../t10-read_file-abcd.txt]
↑ 上方為 tool_result 的外部化指標（CatClaw 自動截斷）。完整原始輸出已寫入該絕對路徑，
如需檢視請呼叫 read_file 讀取——**檔案 175.0 KB 偏大，建議帶 offset/limit 分段讀**
（如 offset:1, limit:200），整檔讀會再次被外部化形成 stub 鏈。…
```

## 絕對不要做的事

**不要直接放棄、不要回報「太大讀不到」「外部化讀不到」「stub 鏈太深」這類話術。** 之前的「套娃 bug」（read_file 對 string 連環 JSON.stringify 累加 escape）**已修復**（commit `bd8bba1`，2026-05-11），fix 後產出的外部化檔內容是乾淨字串，可以正常 read。

**不要用 grep source code 推測檔案內容當替代方案**（除非你已經知道目標關鍵字）。先按下面策略取片段。

## 正確策略（三選一）

依任務性質選：

### A. 找特定欄位 / 關鍵字 → `grep`
```
grep(pattern="raw_text", path="/abs/path/...turn_10.json", -n=true, -A=2)
```
適合：tool-log JSON 內找某次 tool call 結果、找錯誤訊息、找路徑。

### B. 看檔案結構 / 取段落 → `read_file` 帶 `offset` / `limit`
```
read_file(path="/abs/path/...turn_10.json", offset=1, limit=200)
```
先取前 200 行看結構，再依需要 `offset=N` 跳到目標段。
適合：要看 JSON 開頭欄位、看 python 檔某段函式、知道大概行號的內容。

### C. 知道行號範圍 → `read_file` 精準切片
```
read_file(path="...", offset=450, limit=50)
```
適合：grep 找到行號後取上下文。

## Stub 文字裡有檔案絕對路徑與行數，請優先用它

stub 的 `完整內容 @` 後面就是絕對路徑，**直接拿那個路徑做 grep / offset-limit read**，不要再去猜路徑、不要去重跑工具。

## 反例（過去 wendy 踩過）

- ❌ 「tool log 太大讀不到。直接去讀最新的 02_ocr.json」 ← 看到 stub 提示帶 offset/limit 卻直接放棄
- ❌ 「外部化鏈太深，直接找最新的 run 目錄」 ← 跳開 stub 改用 ls/find 推測，繞遠路

## 正例

- ✅ 「stub 標 175 KB／200 行，先 `grep raw_text` 定位 → `read_file offset=120 limit=30` 取目標段。」
- ✅ 「stub 帶路徑 `/.../t10-read_file-abcd.txt`，直接 `read_file(path=該路徑, offset=1, limit=500)` 看前段。」
