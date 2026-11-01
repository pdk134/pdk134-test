# wechat-minigame

微信小游戏：俯视生存竞技场 / 升级选卡（类《吸血鬼幸存者》肉鸽玩法）。

## 玩法
- 主角**自动移动 + 自动攻击**，怪物从屏幕四周持续涌来。
- 击杀怪物获得经验，经验满**升级**，弹出**三选一卡牌**（只能选 1 张）。
- 卡牌分两类：
  - 新技能：多重射击、穿透、暴击、召唤伙伴等
  - 强化现有：攻速、伤害、移速、射程、最大生命、经验获取等
- 单关 5 波次：每波 25 秒。**前 2 波主角单独闯关**；**第 3 波起自动获得 1 名 NPC 伙伴**环绕助战（最多 3 名，也可靠卡牌额外召唤）。
- 活过全部关卡 = 通关胜利；主角生命归零 = 失败，点击重开。

## 运行
1. 用[微信开发者工具](https://developers.weixin.qq.com/minigame/dev/devtools/download.html)打开本目录。
2. AppID 选「测试号」即可（project.config.json 已配 `touristappid`）。
3. 编译预览，游戏自动开始。

## 目录结构
```
wechat-minigame/
├── game.js              # 入口（根目录，require src/main）
├── game.json            # 全局配置（竖屏）
├── project.config.json  # 项目配置
└── src/
    ├── config.js        # 全部数值与配色
    ├── main.js          # 主循环 + 触摸分发
    ├── game.js          # 状态机/刷怪/升级选卡/渲染
    ├── player.js        # 主角：自动移动+自动攻击
    ├── enemy.js         # 敌人
    ├── projectile.js    # 子弹
    ├── companion.js     # NPC 伙伴
    ├── skills.js        # 卡牌池与效果
    └── utils.js         # 数学/绘制工具
```

## 调参
集中在 `src/config.js`：主角属性、敌人强度、刷怪节奏、关卡数与时长、伙伴解锁关卡等。

## 后续可扩展
- 技能图标/美术资源（当前为几何图形占位）
- 更多卡牌：回血、减速光环、激光/炸弹等主动技
-  Boss 关、关卡地图变化
- 音效、震屏、连击特效
- 排行榜、成就、存档
