# Installation / 安装

SciDigitizer is available as a small desktop application and as a browser edition that requires no installation. Images and extracted data stay on the user's computer in both editions.

SciDigitizer 提供轻量桌面版，也提供无需安装的在线版。两种版本都只在用户自己的电脑上处理图片和数据。

- [Releases / 桌面版下载](https://github.com/quchongbing/SciDigitizer/releases)
- [Browser edition / 在线使用](https://quchongbing.github.io/SciDigitizer/)

The desktop preview is not yet code-signed. Download it only from the official release page above. Windows SmartScreen or macOS Gatekeeper may therefore show a warning.

桌面预览版尚未进行代码签名。请只从上面的官方发布页下载；Windows SmartScreen 或 macOS Gatekeeper 因此可能显示安全提醒。

## Windows 10/11 x64

1. Download `SciDigitizer-<version>-windows-x64.zip`.
2. Right-click the ZIP and choose **Extract All**. Do not run the program from inside the ZIP preview.
3. Open the extracted folder and double-click `SciDigitizer.exe`.
4. If SmartScreen appears, verify that the file came from this repository, then choose **More info → Run anyway**.

No traditional installation is needed. Windows 10 and 11 normally include the required Microsoft Edge WebView2 runtime. The extracted folder can be moved anywhere; create a shortcut to `SciDigitizer.exe` if desired. To remove the program, delete that folder.

1. 下载 `SciDigitizer-<版本>-windows-x64.zip`。
2. 右键压缩包并选择**全部解压缩**，不要直接在压缩包预览窗口内运行程序。
3. 进入解压后的目录，双击 `SciDigitizer.exe`。
4. 如果 SmartScreen 出现提示，请先确认文件来自本仓库，再选择**更多信息 → 仍要运行**。

Windows 版是便携程序，无需传统安装。Windows 10/11 通常已经带有所需的 Microsoft Edge WebView2。可以将解压目录移动到任意位置，也可以为 `SciDigitizer.exe` 创建快捷方式。卸载时删除该目录即可。

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

Choose the package before downloading:

- Apple Silicon (M1, M2, M3, M4, and later): `macos-arm64.zip`
- Intel processor: `macos-x64.zip`

Then:

1. Extract the ZIP.
2. Drag `SciDigitizer.app` into **Applications**.
3. For the first launch, Control-click the application, choose **Open**, and confirm **Open** again.
4. Later launches can use Finder, Launchpad, or Spotlight normally.

下载前先选择对应版本：

- Apple 芯片（M1、M2、M3、M4 及后续型号）：`macos-arm64.zip`
- Intel 处理器：`macos-x64.zip`

然后解压文件，将 `SciDigitizer.app` 拖入**应用程序**。首次启动时按住 Control 点击应用，选择**打开**并再次确认；以后可从 Finder、启动台或 Spotlight 正常打开。卸载时将应用移到废纸篓。

## Optional checksum verification / 可选的完整性校验

Download `SHA256SUMS.txt` from the same release. A matching SHA-256 value confirms that the package was downloaded completely and was not changed in transit.

从同一 Release 下载 `SHA256SUMS.txt`。SHA-256 一致，说明下载文件完整且传输过程中未发生变化。

- Windows PowerShell: `Get-FileHash .\SciDigitizer-<version>-windows-x64.zip -Algorithm SHA256`
- Linux: `sha256sum SciDigitizer-<version>-linux-x64.deb`
- macOS: `shasum -a 256 SciDigitizer-<version>-macos-arm64.zip`

Compare the printed value with the corresponding line in `SHA256SUMS.txt`.

将命令输出与 `SHA256SUMS.txt` 中对应文件的数值比较即可。
