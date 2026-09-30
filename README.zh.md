# dsh-plugin-balance-ui

[DeepSeek Harness](https://github.com/deepseek-ai)（dsh）Web 客户端的账户与用量面板。在侧边栏底部加一块：DeepSeek 账户余额、今日 token 用量、今日花费估算，以及当前处于高峰还是空闲计费档。

[English](./README.md)

## 显示什么

侧边栏展开时：

| 行 | 含义 |
| --- | --- |
| 余额 | 来自 `GET /user/balance` 的账户余额，按账户自身币种显示 |
| 今日 | 今日总 token（输入 + 输出 + 缓存命中），紧凑显示 |
| 花费 | 今日花费估算，人民币 |
| 时段 | 当前生效的计费档：`高峰` 或 `空闲` |

侧边栏收起时，同样四个值以紧凑文字竖排在窄栏里。

鼠标悬停会显示完整明细：充值余额与赠送余额、输入 / 输出 / 缓存命中 token 数、请求次数、估算花费背后的高峰与空闲分档小计、当前每百万 token 费率，以及下次档位切换的北京时间。

## 数字是怎么来的

全部在本机根据 dsh 已有的数据算出，除了 DeepSeek 自己的余额接口外不请求任何服务。

- **余额** —— 宿主端用 dsh 凭据层解析出的凭证调用 `https://api.deepseek.com/user/balance`，结果缓存 30 秒。
- **用量** —— 宿主端遍历 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）下的会话日志，解压 `.jsonl.zstd`，累计每一条时间戳在本地今日零点之后的 `assistant/message` 记录。结果缓存 10 秒。只读文件，不写回任何内容。
- **花费** —— 浏览器端按 DeepSeek 公布的人民币价目表，对每个模型行分别用高峰桶与空闲桶计价。

`reasoningTokens` 由宿主端上报但不单独计费，因为它本身是 `outputTokens` 的子集。缓存写入 token 一律按 0 计价：官方价目表只列了缓存命中输入、缓存未命中输入和输出三项。

### 高峰与空闲

DeepSeek 分两档计费，空闲档是高峰档的半价。高峰为北京时间（UTC+8）周一至周五 09:00–12:00 与 14:00–18:00，不含中国法定节假日；其余时间——包括全部周末与节假日——均为空闲。

宿主端会给每条 assistant 消息按落入的时段打标，因此每一档都按自己的费率计价，而不是取混合均价。时段徽标由独立定时器驱动、直接调度到下一个北京时间的档位切换点，所以它会在 09:00 / 12:00 / 14:00 / 18:00 / 零点当场翻转，而不是最多迟一个轮询周期。

### 费率

摘自 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>，人民币 / 每百万 token：

| 模型 | 档位 | 输入 | 输出 | 缓存命中 |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | 高峰 | ¥2 | ¥8 | ¥0.04 |
| `deepseek-flash` | 空闲 | ¥1 | ¥4 | ¥0.02 |
| `deepseek-v4-pro` | 高峰 | ¥9 | ¥27 | ¥0.3 |
| `deepseek-v4-pro` | 空闲 | ¥4.5 | ¥13.5 | ¥0.15 |

已下线的 id `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 映射到 `deepseek-flash`，因为服务端仍接受这两个名字并按 Flash 价格计费。价目表里没有的模型会标为无费率，花费行显示 `—`，不做猜测。

2026 年中国法定节假日为显式列表，来源是《国务院办公厅关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号）。调休上班的周六周日无需登记，因为周末本来就按空闲计价。**这份节假日表每年需要更新一次**——下一年度的通知在每年 11 月发布。列表未覆盖的年份按「没有节假日」处理，只会让工作日高峰时段的花费略微高估，不会出错。

**花费数字是估算，不是账单。** 它由本机记录的 token 数与公开价目表算出，不知道折扣、赠送额度，也不知道本次发布之后 DeepSeek 的任何调价。

## 安装

在插件市场（dsh-market）里搜索 `balance-ui`。

或从命令行：

```sh
dsh plugin --profile web add dsh-plugin-balance-ui
```

然后重启 dsh 服务以重新合成 profile 层。

## 前置条件

- 一个使用 Web 应用的 dsh profile。
- dsh 凭据层中可用的 DeepSeek API key，名为 `DEEPSEEK_API_KEY`。没有它时用量各行照常工作，只有余额行显示错误。
- Node.js ≥ 22.15.0（宿主端使用 `zlib.zstdDecompressSync`）。

## 路由

宿主端注册两个同源、只读的 JSON 路由：

| 路由 | 内容 |
| --- | --- |
| `GET /dsh-balance` | `{ ok, available, infos: [{ currency, total, granted, toppedUp }] }` |
| `GET /dsh-usage` | 今日 token 总数、高峰/空闲分桶，以及按模型分组的行 |

两者都会拒绝非 `GET`/`HEAD` 方法与跨源请求，并返回 `cache-control: no-store`。

## 隐私

API key 只在 dsh 进程内解析，仅用于调用上游余额接口。它不会出现在任何响应、日志或错误信息中。插件只读取会话日志，不写入任何内容。没有遥测，也不接第三方服务。

## 许可

MIT，见 [LICENSE](./LICENSE)。
