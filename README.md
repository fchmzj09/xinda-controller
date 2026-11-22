# 追魅 / 昕达控制器 · Android 独立版

把一个 BLE 控制器配套的微信小程序改造成**无需微信、直接安装在 Android 手机上**的独立 App。
内置小程序运行时 + 原生 BLE 桥接，UI 重新设计为白色简约风格。

> 顶部标题：**昕达控制器** · 桌面应用名：**追魅**

## 功能

- 扫描并连接 BLE 控制器（FFF0 服务）
- 实时显示转速、母线/相线电压电流、温度、档位与故障状态
- 基础/高级参数读写、自学习、恢复出厂设置
- OTA 升级通道
- 前台保活服务，后台维持 BLE 连接

## 仓库里有什么 / 没有什么

本仓库只包含**独立 App 的外壳与文档**：

| 内容 | 路径 |
| --- | --- |
| WebView 运行时（渲染器 / wx API / 路由 / 调试通道） | `app/assets/wx/js/runtime.js` |
| 外壳布局与白色简约主题 | `app/assets/wx/css/base.css`, `theme.css` |
| Java 原生层（MainActivity / BleBridge / KeepAliveService） | `app/java/com/tm/zhuimei/` |
| 构建脚本 | `build.sh` |
| 蓝牙协议说明 | `docs/BLE_PROTOCOL.md` |
| 可直接安装的 APK | `dist/xinda-controller.apk` |

**不包含**原微信小程序的反编译产物（`app-service.js`、`page-frame.js`、图片资源、
`unpacked/` 等）。这些代码归原作者所有，请从你自己合法取得的 wxapkg 中提取后放到：

```
app/assets/wx/js/app-service.js
app/assets/wx/js/page-frame.js
app/assets/wx/img/*.png
```

没有这几个文件，源码构建出来的 App 只有空壳；现成的 APK 在 `dist/` 里可以直接安装。

## 构建

需要 Android 构建工具（aapt2、d8/zipalign/apksigner、android.jar）。把工具放到 `tools/`
目录，或通过环境变量 `ANDROID_TOOLS` 指定：

```
tools/
├── aapt2
├── build-tools/<version>/d8
├── build-tools/<version>/zipalign
├── build-tools/<version>/apksigner
└── platform/android-36/android.jar
```

然后：

```
bash build.sh
```

签名：默认在仓库根目录生成 `debug.keystore`（密码 `android`，仅用于调试）。
正式发布请换成自己的 keystore：

```
KEYSTORE=/path/to/release.jks KEY_PASS=yourpass STORE_PASS=yourpass bash build.sh
```

## 安装

```
adb install -r dist/xinda-controller.apk
```

首次启动需要授权：蓝牙扫描/连接（Android 12+）、通知（前台服务）、忽略电池优化。

## 调试通道

App 每 300ms 检查 `files/cmd.txt`，把其中 JS 的执行结果写到 `files/result.txt`；
`NativeBridge.snapshot()` 可把 WebView 截图写到 `files/snap.png`。仅用于开发。

## 许可

MIT — 详见 [LICENSE](LICENSE)。原微信小程序代码不在本仓库内，其权利归原作者所有。
