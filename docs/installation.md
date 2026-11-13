# Installation / 安装

SciDigitizer is available as a small desktop application and as a browser edition that requires no installation. Images and extracted data stay on the user's computer in both editions.

SciDigitizer 提供轻量桌面版，也提供无需安装的在线版。两种版本都只在用户自己的电脑上处理图片和数据。

- [Releases / 桌面版下载](https://github.com/quchongbing/SciDigitizer/releases)
- [Browser edition / 在线使用](https://quchongbing.github.io/SciDigitizer/)

Download only from the official release page above and check its version notes. Windows previews have no Authenticode publisher signature. New macOS builds use an ad-hoc signature for executable integrity, not a verified Developer ID or Apple notarization; Gatekeeper may still block their first launch. Older releases, including `0.20.0-preview.3.24`, do not contain the macOS signing fix.

请只从上面的官方发布页下载，并核对版本说明。Windows 预览版没有发布者签名。新打包流程为 macOS 加入临时签名（ad-hoc），用于校验可执行文件；它不是 Developer ID 签名，也未经过 Apple 公证，首次启动仍可能被 Gatekeeper 拦截。`0.20.0-preview.3.24` 等旧版本不包含本次 Mac 签名修复。

## Windows 10/11 x64

1. Download `SciDigitizer-<version>-windows-x64.zip`.
2. Right-click the ZIP and choose **Extract All**. Do not run the program from inside the ZIP preview.
3. Open the extracted folder and double-click `SciDigitizer.exe`.
4. If SmartScreen appears, verify that the file came from this repository, then choose **More info → Run anyway**.

No traditional installation is needed. Use a local folder in your user profile, such as Documents, and create a shortcut if desired. Windows 10 and 11 normally include the required Microsoft Edge WebView2 Runtime, but not every installation has it. An installed Edge browser is not a substitute for the Runtime.

If the app reports a missing WebView2 Runtime or will not start, install **Evergreen Standalone Installer → x64** from [Microsoft's WebView2 download page](https://developer.microsoft.com/microsoft-edge/webview2/) and retry. The shared runtime is a separate dependency and is not included in SciDigitizer's small ZIP. A 32-bit Windows installation is not supported; Windows ARM64 has no native SciDigitizer package and is not verified.

If Windows blocks the app without offering **Run anyway**, follow your organization's security policy or use the browser edition. Do not disable Defender/SmartScreen or run as administrator to work around it. To remove the app, delete its extracted folder; this does not delete previously exported data.

1. 下载 `SciDigitizer-<版本>-windows-x64.zip`。
2. 右键压缩包并选择**全部解压缩**，不要直接在压缩包预览窗口内运行程序。
3. 进入解压后的目录，双击 `SciDigitizer.exe`。
4. 如果 SmartScreen 出现提示，请先确认文件来自本仓库，再选择**更多信息 → 仍要运行**。

Windows 版是便携程序，建议解压到当前用户的本地目录（如“文档”），再创建快捷方式。Windows 10/11 通常已安装 WebView2 Runtime，但并非每台电脑都有；安装了 Edge 浏览器不等于安装了该运行时。

若提示缺少 WebView2 或无法启动，请从 [微软官方下载页](https://developer.microsoft.com/microsoft-edge/webview2/)安装 **Evergreen Standalone Installer → x64**，完成后重试。这个共享运行时不包含在 SciDigitizer 的小体积 ZIP 中。32 位 Windows 不受支持；Windows ARM64 暂无原生包，也未经验证。

若系统不提供“仍要运行”，请遵循单位的安全策略，或使用在线版，不要关闭 Defender/SmartScreen 或以管理员身份强行运行。卸载时删除解压目录即可，不影响已导出的数据。

## Ubuntu and Debian x64

The `.deb` package is recommended because the system package manager can install the required GTK and WebKitGTK libraries automatically.

1. Download `SciDigitizer-<version>-linux-x64.deb`.
2. Double-click it and open it with **App Center** or **Software Install**.
3. Choose **Install**, then find **SciDigitizer** in the application menu.

If the graphical installer cannot open a local package, run this command from the download directory:

```bash
sudo apt install ./SciDigitizer-<version>-linux-x64.deb
```

To uninstall:

```bash
sudo apt remove scidigitizer
```

推荐使用 `.deb`，因为系统包管理器会自动安装所需的 GTK 和 WebKitGTK 运行库。

1. 下载 `SciDigitizer-<版本>-linux-x64.deb`。
2. 双击文件，使用 **App Center/应用中心**或**软件安装**打开。
3. 点击**安装**，完成后在应用程序菜单中搜索 **SciDigitizer**。

如果图形安装器无法打开本地安装包，可在下载目录运行上面的 `apt install` 命令。卸载时运行 `sudo apt remove scidigitizer`。

## Other Linux distributions and Linux arm64

1. Choose the ZIP matching the computer architecture: `linux-x64.zip` for x86_64/AMD64, or `linux-arm64.zip` for ARM64/AArch64.
2. Extract it and double-click `SciDigitizer` in the file manager.
3. If it does not start, open the file's **Properties → Permissions** and allow it to run as a program.
4. Ensure that GTK 3 and WebKitGTK 4.1 or 4.0 are installed from the distribution's package manager.

The portable ZIP is not fully self-contained: it deliberately reuses the Linux system WebView to keep the download near one megabyte.

1. 根据电脑架构选择压缩包：x86_64/AMD64 使用 `linux-x64.zip`，ARM64/AArch64 使用 `linux-arm64.zip`。
2. 解压后，在文件管理器中双击 `SciDigitizer`。
3. 如果不能启动，请打开文件的**属性 → 权限**，允许其作为程序执行。
4. 使用当前发行版的软件包管理器安装 GTK 3，以及 WebKitGTK 4.1 或 4.0。

Linux 便携版并非包含所有系统库；为了把下载体积控制在约 1 MB，它会复用系统的 WebView。

## macOS

The currently pinned runtime requires **macOS 14 or later** for both architectures. The build reads this requirement from the executable rather than assuming support for older systems.

当前固定版本的运行时在两种架构上均要求 **macOS 14 或更新系统**。打包时会读取二进制文件的实际要求，不再错误标注为 10.13。

Choose the package before downloading:

- Apple Silicon (M1, M2, M3, M4, and later): `macos-arm64.zip`
- Intel processor: `macos-x64.zip`

Then:

1. Extract the ZIP.
2. Drag `SciDigitizer.app` into **Applications**.
3. Try opening the app. If Gatekeeper blocks it, verify the official source and checksum, then open **System Settings → Privacy & Security → Open Anyway** and confirm the exception. From macOS 15 onward, Control-click → Open does not override this check.
4. Later launches can use Finder, Launchpad, or Spotlight normally.

下载前先选择对应版本：

- Apple 芯片（M1、M2、M3、M4 及后续型号）：`macos-arm64.zip`
- Intel 处理器：`macos-x64.zip`

然后解压文件，将 `SciDigitizer.app` 拖入**应用程序**，尝试打开。若被 Gatekeeper 拦截，先核对下载来源和校验值，再进入**系统设置 → 隐私与安全性 → 仍要打开**并确认。从 macOS 15 起，Control 点击“打开”不再绕过此检查。以后可从 Finder、启动台或 Spotlight 打开；卸载时将应用移到废纸篓。

Do not disable Gatekeeper globally or remove quarantine attributes to hide a damaged-app warning. If the app is reported as damaged, crashes immediately, or has no **Open Anyway** option, use the browser edition and report the macOS version, Intel/Apple Silicon model, exact ZIP name/version, and full error message in an issue. An ad-hoc signature does not guarantee that every security policy will allow the app.

不要全局关闭 Gatekeeper，也不要删除隔离属性来掩盖“应用已损坏”的提示。若提示损坏、启动即退出，或没有“仍要打开”选项，请暂用在线版，并在 issue 中提供系统版本、Intel/Apple 芯片型号、完整安装包名和版本，以及完整错误信息。临时签名不代表一定能通过所有安全策略。

References: [Apple's Gatekeeper changes](https://developer.apple.com/news/?id=saqachfa), [opening trusted apps](https://support.apple.com/102445), [Microsoft's WebView2 distribution guide](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution).

## Optional checksum verification / 可选的完整性校验

Download `SHA256SUMS.txt` from the same release. A matching SHA-256 value confirms that the package was downloaded completely and was not changed in transit.

从同一 Release 下载 `SHA256SUMS.txt`。SHA-256 一致，说明下载文件完整且传输过程中未发生变化。

- Windows PowerShell: `Get-FileHash .\SciDigitizer-<version>-windows-x64.zip -Algorithm SHA256`
- Linux: `sha256sum SciDigitizer-<version>-linux-x64.deb`
- macOS: `shasum -a 256 SciDigitizer-<version>-macos-arm64.zip`

Compare the printed value with the corresponding line in `SHA256SUMS.txt`.

将命令输出与 `SHA256SUMS.txt` 中对应文件的数值比较即可。
