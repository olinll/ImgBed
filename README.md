# ImgBed

私有化图床服务，支持本地存储和 S3 兼容存储（Aliyun OSS / Tencent COS / MinIO）。

## 部署

```bash
docker compose up -d
```

## 存储渠道

- **本地存储**: 文件存储在 `./data/local/` 目录
- **S3 兼容**: 支持 Aliyun OSS / Tencent COS / MinIO

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 服务端口 | `8080` |
| `LOCAL_STORAGE_PATH` | 本地存储路径 | `/app/data/local` |
| `AUTH_CODE` | 用户上传鉴权码 | 空（不鉴权） |
| `BASIC_USER` | 管理员用户名 | 空 |
| `BASIC_PASS` | 管理员密码 | 空 |
| `S3_ACCESS_KEY_ID` | S3 Access Key | - |
| `S3_SECRET_ACCESS_KEY` | S3 Secret Key | - |
| `S3_BUCKET_NAME` | S3 Bucket 名称 | - |
| `S3_ENDPOINT` | S3 端点 URL | - |
| `S3_REGION` | S3 区域 | `auto` |
| `S3_PATH_STYLE` | 使用路径风格（MinIO 需设为 true） | `false` |
| `S3_CDN_DOMAIN` | S3 CDN 域名 | 空 |

### S3 兼容配置示例

**Aliyun OSS:**
```yaml
environment:
  - S3_ACCESS_KEY_ID=your_key
  - S3_SECRET_ACCESS_KEY=your_secret
  - S3_BUCKET_NAME=your-bucket
  - S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
  - S3_REGION=oss-cn-hangzhou
```

**Tencent COS:**
```yaml
environment:
  - S3_ACCESS_KEY_ID=your_secret_id
  - S3_SECRET_ACCESS_KEY=your_secret_key
  - S3_BUCKET_NAME=your-bucket-appid
  - S3_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com
  - S3_REGION=ap-guangzhou
```

**MinIO:**
```yaml
environment:
  - S3_ACCESS_KEY_ID=minioadmin
  - S3_SECRET_ACCESS_KEY=minioadmin
  - S3_BUCKET_NAME=imgbed
  - S3_ENDPOINT=http://minio:9000
  - S3_REGION=us-east-1
  - S3_PATH_STYLE=true
```

## WebDAV 访问

内置 WebDAV 服务端，可在管理后台开启后通过 `/dav/` 端点访问。

## 开发

```bash
npm install
npm run start:docker
```
