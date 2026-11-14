# 贡献指南

## 开发

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 单元测试
npm run typecheck  # 类型检查
npm run build      # 生产构建
```

提交前请确保这四条都通过——CI 跑的就是它们。

> Windows 上用 Vitest 如果遇到并行 worker 写临时目录报 `EPERM`，加上 `--no-file-parallelism` 串行运行即可。

## 代码约定

- 用 TypeScript 严格模式，不用 `any`。
- 不引入运行时框架。这个项目的体积优势（27 KB）是靠不用框架换来的。
- 硬件相关的代码越薄越好：`core/` 下的解析器、录制、统计都不应该碰 DOM 或 Web Serial API，这样它们能在 Node 里直接测。
- 新增解析器请实现 `Parser` 接口并注册到 `parsers/index.ts`，不要改主流程。

## 修 bug

请附带一个能复现问题的测试。这个项目里几个最难查的问题（回放时序、帧同步卡死）都是靠测试才暴露出来的，靠手点发现不了。

## 新增解析器

```ts
export const myParser: Parser = {
  id: 'my-proto',
  name: 'MyProto',
  hint: '帧头 AA55 + 长度 + 负载 + 校验和',
  parse(queue) {
    if (queue.size < 4) return null;                 // 数据不足
    if (queue.at(0) !== 0xaa) return { kind: 'skip', count: 1 }; // 重新同步
    const len = queue.at(2);
    const total = len + 5;
    if (queue.size < total) return null;
    const frame = queue.slice(0, total);
    return { kind: 'frame', frame, consumed: total, decoded: { /* ... */ } };
  },
};
```

三个返回值对应三种状态：切出帧、跳过若干字节、数据不足。只要这三件事想清楚，任何自定界协议都能接进来。

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
fix(recorder): 回放按累计间隔调度，而不是每个事件各自定时
feat(parser): 支持写多线圈的位打包解析
docs(readme): 补充真实硬件未验证的说明
test(modbus): 覆盖 CRC 错帧后的重同步
```

## 不要做的事

- 不要提交与功能无关的格式化改动（整个文件重排会让 review 无法进行）。
- 不要为了提高测试覆盖率写没有断言的测试。
- 不要在 README 里写未经验证的性能数字。
