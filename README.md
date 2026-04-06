# cfmail

面向域名邮箱的 Cloudflare Worker 邮件服务：  
**收件进 KV，API 取件；发件走 Resend（可选但内置）。**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mazixuan69/cfmail)
[![Built with Cloudflare](https://workers.cloudflare.com/built-with-cloudflare.svg)](https://cloudflare.com)
[![License](https://img.shields.io/github/license/mazixuan69/cfmail)](LICENSE)
[![Last Commit](https://img.shields.io/github/last-commit/mazixuan69/cfmail)](https://github.com/mazixuan69/cfmail/commits)

## 为什么是它

`cfmail` 不是“又一个邮件转发”，而是你的域名邮箱 API 后台：
- 收件：Email Routing -> Worker -> KV（原始 MIME）
- 取件：REST API 拉取列表/详情/原文
- 发件：一键接 Resend，统一接口
- 管理：管理员管用户，用户 token 只管自己邮箱

## 功能速览

- 收件保存：原始 MIME + 元数据
- 用户隔离：每个邮箱独立收件箱
- 管理能力：用户创建、禁用、重置 token
- API 访问：列表、详情、原文、删除
- 外发邮件：`POST /outgoing-emails` 直通 Resend

## 架构一眼懂

```
Internet Mail -> Cloudflare Email Routing -> Worker (email event)
                                         -> KV (raw MIME + metadata)
Client API  -> Worker (fetch) -> KV (list/get/delete)
Client API  -> Worker (fetch) -> Resend API (send)
```

## 快速开始

**方式 A：一键部署（推荐）**
1. 点击上面的 **Deploy to Cloudflare** 按钮  
2. Cloudflare 会帮你创建仓库副本、配置资源并部署  
3. 部署完成后在 Dashboard 里继续修改/发布

**方式 B：手动部署**
1. 创建 KV 命名空间  
2. 记下 KV ID，写入 `wrangler.toml`

**2. 配置 Secrets**
- `ADMIN_TOKEN` 管理员 token
- `RESEND_API_KEY` Resend API key（需要发件时再配）

**3. 部署**
```
wrangler deploy
```

## 认证模型

- 管理员接口：`Authorization: Bearer <ADMIN_TOKEN>`
- 用户接口：`Authorization: Bearer <USER_TOKEN>`

## 配置示例

**`wrangler.toml` 关键字段**
```
name = "cfmail"
main = "src/index.ts"
compatibility_date = "2026-04-06"

[[kv_namespaces]]
binding = "MAIL_KV"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

**环境变量 / Secret**

| 名称 | 必需 | 作用 |
| --- | --- | --- |
| `MAIL_KV` | 是 | KV 命名空间绑定 |
| `ADMIN_TOKEN` | 是 | 管理员鉴权 token |
| `RESEND_API_KEY` | 否 | 启用发件（Resend） |

## 主要 API

**管理员**
- `POST /admin/users`  
  body: `{ "address": "user@example.com" }`
- `GET /admin/users?limit=&cursor=`
- `PATCH /admin/users/:address`  
  body: `{ "status": "active|disabled" }`
- `POST /admin/users/:address/rotate-token`
- `DELETE /admin/users/:address`
- `GET /admin/emails?mailbox=unassigned`
- `GET /admin/emails/:id?mailbox=...`
- `GET /admin/emails/:id/raw?mailbox=...`
- `DELETE /admin/emails/:id?mailbox=...`

**用户**
- `GET /emails?limit=&cursor=`
- `GET /emails/:id`
- `GET /emails/:id/raw`
- `DELETE /emails/:id`
- `POST /outgoing-emails`  
  body 直接使用 Resend `POST /emails` 结构

## API 示例

**创建用户**
```
curl -X POST https://<your-worker>/admin/users \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"address":"user@example.com"}'
```

**列出邮箱里的邮件**
```
curl https://<your-worker>/emails \
  -H "Authorization: Bearer <USER_TOKEN>"
```

**获取原始 MIME**
```
curl https://<your-worker>/emails/<id>/raw \
  -H "Authorization: Bearer <USER_TOKEN>"
```

**发一封邮件**
```
curl -X POST https://<your-worker>/outgoing-emails \
  -H "Authorization: Bearer <USER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "you@yourdomain.com",
    "to": "someone@example.com",
    "subject": "Hello from cfmail",
    "text": "Plain text body"
  }'
```

## 数据存储约定

- 用户记录：`user:<address>`
- token 映射：`token:<token>`
- 原始邮件：`msg:<mailbox>:<id>`
- 元数据：`meta:<mailbox>:<id>`

## 默认行为

- 原始 MIME 直接存 KV
- TTL = 30 天
- 未知/禁用收件人 -> `unassigned`
- KV 最终一致，列表可能短暂延迟

## 版本与路线

- v0.1：收件 + 取件 + 管理 + Resend 发件
- v0.2：邮件解析（text/html）、附件索引、搜索

## License

MIT

## FAQ

**Q: 为什么列表里偶尔看不到刚收的邮件？**  
A: KV 是最终一致，列表可能延迟几十秒，稍后再试即可。

**Q: 收件人不在用户表里会怎样？**  
A: 会进入 `unassigned` 信箱，管理员可查看。

**Q: 发件必须走 Resend 吗？**  
A: 目前是可选项。Worker 内置 Resend 支持，但未配置 `RESEND_API_KEY` 时会返回错误。
