# 厂商跟进 · Google Sheet 后端搭建

**你需要做的一次性配置**（大概 10 分钟）。做完给我 Web App URL，我把它接进前端。

---

## 步骤 1：新建 Google Sheet

1. 打开 https://sheets.google.com/
2. 新建空白电子表格，命名为 **"minigame-publisher-status"**
3. 第一行 A1 填 `publisher`，B1 填 `status`，C1 填 `updated_at`
4. 记下浏览器地址栏的 URL 里那串 ID（`https://docs.google.com/spreadsheets/d/【这一串】/edit`），后面 Apps Script 会用到 —— 但如果脚本和 Sheet 绑定就不需要，我们下面走绑定的方式。

---

## 步骤 2：打开 Apps Script

1. 在这个 Sheet 里，顶部菜单：**扩展程序 → Apps Script**
2. 会打开一个新标签，默认有一个 `Code.gs` 文件，里面是 `function myFunction() {}`
3. 全选删除，粘贴下面的代码：

```javascript
// Google Apps Script webhook: read/write publisher follow-up status.
// Deploy this as a Web App (Anyone can access) and copy the URL.
//
// Sheet layout (first row = headers):
//   A: publisher   B: status   C: updated_at

const VALID_STATUSES = new Set(["pending", "contacted", "rejected", "closed"]);

function doGet(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const values = sheet.getDataRange().getValues();
  const out = {};
  for (let i = 1; i < values.length; i++) {
    const [pub, status] = values[i];
    if (pub) out[pub] = status || "pending";
  }
  return jsonOk(out);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonErr("bad json");
  }
  const publisher = String(body.publisher || "").trim();
  const status = String(body.status || "").trim();
  if (!publisher) return jsonErr("missing publisher");
  if (!VALID_STATUSES.has(status)) return jsonErr("bad status");

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const values = sheet.getDataRange().getValues();
  const now = new Date().toISOString();
  let foundRow = -1;
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === publisher) { foundRow = i + 1; break; }
  }
  if (foundRow === -1) {
    sheet.appendRow([publisher, status, now]);
  } else {
    sheet.getRange(foundRow, 2).setValue(status);
    sheet.getRange(foundRow, 3).setValue(now);
  }
  return jsonOk({ ok: true, publisher, status, updated_at: now });
}

function jsonOk(data) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data }))
    .setMimeType(ContentService.MimeType.JSON);
}
function jsonErr(msg) {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

4. Ctrl+S 保存（会让你给项目命名，随便起，比如 `publisher-status`）

---

## 步骤 3：部署为 Web App

1. 顶部右侧点 **部署 → 新部署**
2. 类型（左上齿轮图标）选 **Web 应用**
3. 参数：
   - **说明**：随便写，如 `v1`
   - **执行身份**：**我**（Me）
   - **访问权限**：**任何人**（Anyone）—— 这一步很关键
4. 点 **部署**
5. 会弹出授权，一路 **允许 / 高级 / 转到（不安全）** 通过。看到"应用未验证"的红字警告是正常的（因为是你自己的脚本）

---

## 步骤 4：复制 URL 给我

部署完成后会显示一个 **Web App URL**：

```
https://script.google.com/macros/s/<很长一串>/exec
```

复制这个完整 URL，粘给我。

---

## 步骤 5：验证

在浏览器直接打开那个 URL，应该看到：

```json
{"ok":true,"data":{}}
```

（空对象 `{}` 是正常的，Sheet 里还没数据）

如果报错、要登录、看到别的东西 —— 部署配置没做对，回去检查步骤 3 里"访问权限"是否选了"任何人"。

---

## 做完之后

把 Web App URL 发我，我把它接进前端，然后加"厂商跟进"页面。你不需要再动 Google 那边。

后续可以直接打开 Sheet 手动改状态、批量操作，前端会同步显示。
