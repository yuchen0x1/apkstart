# ApkStart 0.10.5 生态研究记录

日期：2026-11-23。本文记录本轮对比的公开资料和实际落地边界；没有复制第三方代码，也没有把闭源功能写成已实现能力。

## 研究对象与结论

| 项目 | 公开资料观察 | 对 ApkStart 的可落地结论 |
| --- | --- | --- |
| RoutineMiku/apkstart | 上游仍采用 Electron + Android Emulator/QEMU + ADB，强调按需部署和独立应用窗口 | 继续保持 Provider/运行时边界，不重复引入第二套模拟器编排 |
| scrcpy | 官方项目强调 ADB 生命周期、丢弃过期帧、硬件解码失败回退软件解码 | 保持“真实设备/运行时归属 + 明确回退”原则；不把视频帧优化误套到宿主窗口嵌入 |
| Android Emulator | 官方文档将 VM 加速、GPU 渲染和 Quick Boot 分开配置，并要求用 `sys.boot_completed` 等证据判断就绪 | 运行时状态必须独立记录：进程存活不等于 Android ready；GPU/快照故障不能互相伪装 |
| Android-x86 | 以 x86/x86_64 系统镜像和 QEMU/虚拟化为核心，硬件能力取决于镜像和宿主 | 继续用真实镜像清单和 ABI 证据驱动兼容性，不凭名称承诺传感器/蓝牙 |
| Bliss OS | QEMU 文档明确区分软件渲染、VirGL/物理 GPU 和 Windows 支持限制 | QEMU Provider 保留保守能力声明；Windows 不宣称未验证的 GPU 加速 |
| Genymotion | 文档记录快照恢复、混合显卡与 Intel 驱动的现实限制，多实例资源受宿主约束 | 设置页要显示“已检测/未确认”，多实例资源需按实例归属，不能只堆 UI 卡片 |
| Waydroid | 采用 Linux 容器并依赖 Wayland/Mesa，性能与宿主内核/GPU 强绑定 | 不把容器能力移植到 Windows；Linux 仍明确是独立窗口的虚拟化路径 |
| Anbox | 原项目已停止维护，依赖 Linux namespaces/LXC，安全边界不同于完整 VM | 文档明确 ApkStart 的数据目录隔离不等于安全沙箱，不引入停更运行时 |
| BlueStacks 多开 | 多实例管理器提供克隆、资源档位、批量操作和 Eco Mode | 未来多实例应优先做真实独立 userdata、资源限制和批量生命周期，先不添加无后端的按键编辑 UI |

## 分类

- **可直接复用**：只复用公开协议和工程原则（ADB 设备归属、Quick Boot 证据、GPU 回退、资源档位），不复制实现代码。
- **自行实现**：设置热路径缓存、运行时状态取证、每实例目录与任务锁，均在本项目现有架构内完成。
- **仅借鉴设计**：BlueStacks 的 Eco Mode/多开界面、Genymotion 的设备卡片和 Waydroid 的桌面整合；它们依赖不同的运行时与许可，当前不宣称已实现。

## 本轮实际落地

`src/core/store.js` 为高频设置读取加入基于文件指纹的内存缓存，并在写入成功或外部文件变化时失效；新增回归覆盖缓存命中、外部修改、默认值隔离和原有损坏/权限保护。该优化减少状态轮询中的同步 JSON 解析，不改变配置格式或用户数据位置。

## 来源

- [RoutineMiku/apkstart](https://github.com/RoutineMiku/apkstart)
- [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)
- [Android Emulator hardware acceleration](https://developer.android.com/studio/run/emulator-acceleration)
- [Android Emulator release notes](https://developer.android.com/studio/releases/emulator)
- [Android-x86](https://www.android-x86.org/)
- [Bliss OS QEMU guide](https://docs.blissos.org/installation/install-in-a-virtual-machine/install-in-qemu/)
- [Genymotion Desktop requirements](https://support.genymotion.com/hc/en-us/articles/360005432518-What-are-Genymotion-Desktop-requirements)
- [Waydroid](https://waydro.id/)
- [Anbox](https://github.com/anbox/anbox)
- [BlueStacks Multi-instance Manager](https://support.bluestacks.com/hc/en-us/articles/4422291276429-How-to-change-settings-in-the-Multi-instance-Manager-on-BlueStacks-5)
