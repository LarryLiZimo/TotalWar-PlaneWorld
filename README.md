# 平原四兵

俯视的二维实时会战。规则见 [RULES.md](RULES.md)。战斗结算在 `src/sim`，不依赖页面；`src/main.ts` 是第一场演示。

```bash
npm install
npm test
npm run dev
```

浏览器打开 http://127.0.0.1:5173 。南军在画面下方。左键选择，右键移动或攻击，右键拖线拉正面，拖方阵两侧圆点改宽度。P 暂停，按住 Alt 看队形，按住空格看体力。
