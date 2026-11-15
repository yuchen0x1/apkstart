# 失败报告收集端

ApkStart 客户端在开机失败时会生成一份**已脱敏**的诊断摘要（用户名路径 → `%USERPROFILE%`），
配好这里的地址后可以直接 POST 过来；Worker 负责入库、限流，并可选转发到你的邮箱。

## 为什么需要它

客户端里不能内置 GitHub token（反编译即泄露），也没有别的方式在没有服务端的情况下
「自动」上报。这个 Worker 就是那个服务端，免费额度足够个人项目用：

- 请求：每天 10 万次（失败报告远低于这个量）
- KV：1 GB 存储、每天 10 万次读（每份报告几 KB，保留 90 天）

## 部署（5 分钟）

```bash
npm i -g wrangler
wrangler login

# 1) 建 KV，把输出的 id 填进 wrangler.toml
wrangler kv namespace create REPORTS

# 2) 管理口令（查看报告时用；不设则管理接口关闭）
wrangler secret put ADMIN_TOKEN

# 3) 可选：转发到邮箱（Resend 免费额度 3000 封/月）
wrangler secret put RESEND_API_KEY
wrangler secret put MAIL_TO          # 你的真实收件邮箱
# 可选：wrangler secret put MAIL_FROM  # 已在 Resend 验证过的发件地址

# 4) 发布
wrangler deploy
```

部署完会得到一个地址，例如：

```
https://apkstart-reports.<你的子域>.workers.dev
```

## 接到客户端

两种方式，任选其一：

1. **写进发行版（推荐）**：`package.json`

   ```json
   "feedback": {
     "repo": "yuchen0x1/apkstart",
     "email": "you@example.com",
     "endpoint": "https://apkstart-reports.xxx.workers.dev"
   }
   ```

   这样所有用户装完即生效，失败时自动上报（用户可在「设置 → 问题反馈」关掉）。

2. **单机调试**：`%APPDATA%\apkstart\settings.json`
   ```json
   { "report": { "endpoint": "https://apkstart-reports.xxx.workers.dev" } }
   ```

## 自测

```bash
curl https://apkstart-reports.xxx.workers.dev/health

curl -X POST https://apkstart-reports.xxx.workers.dev/ \
  -H 'content-type: application/json' \
  -d '{"version":"0.6.1","code":"TIMEOUT","signature":"test","summary":"### 测试报告\n这是一条手动测试。"}'
# → {"ok":true,"id":"..."}
```

查看最近上报：

```bash
curl "https://apkstart-reports.xxx.workers.dev/reports?token=$ADMIN_TOKEN"
curl "https://apkstart-reports.xxx.workers.dev/r/<id>?token=$ADMIN_TOKEN"
```

## 接口约定（想换成自己的服务端时照这个实现即可）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/` 或 `/report` | 收 JSON：`signature/version/at/code/title/exitCode/facts/attempts/summary`，≤256 KB，同 IP 60 秒一条 |
| GET | `/health` | 存活检查 |
| GET | `/reports?token=` | 最近 50 条键名 |
| GET | `/r/<id>?token=` | 单条全文 |

客户端只要求 POST 返回 2xx；其它字段随意（多余字段会被忽略）。

## 隐私

- 客户端在**生成阶段**就把家目录/用户名/临时目录替换成占位符，服务端拿不到原始路径；
- 报告不含已装应用列表、APK 文件、账号信息；
- 默认保留 90 天后自动过期，想立刻删：`wrangler kv key delete --namespace-id=<id> "report:<id>"`。
