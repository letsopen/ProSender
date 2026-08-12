import LanCore from './utils/lan/core';

App({
  onLaunch() {
    // 启动后立即初始化 UDP 发现与 TCP 监听, 并清理过期临时文件
    LanCore.init();
  },
});
