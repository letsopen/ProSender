import gulpError from './utils/gulpError';
import LanCore from './utils/lan/core';
App({
    onLaunch() {
        // 启动后立即初始化 UDP 发现与 TCP 监听, 并清理过期临时文件
        LanCore.init();
    },
    onShow() {
        if (gulpError !== 'gulpErrorPlaceHolder') {
            wx.redirectTo({
                url: `/pages/gulp-error/index?gulpError=${gulpError}`,
            });
        }
    },
});
