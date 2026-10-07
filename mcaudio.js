'use strict';

// The controls live in the MeshCentral desktop ViewMode toolbar. Keep this
// plugin hook so existing plugin installs load cleanly without adding a second
// audio tab or a separate controls window.
module.exports.mcaudio = function (parent) {
    return {
        parent: parent,
        exports: ['onDeviceRefreshEnd'],
        onDeviceRefreshEnd: function () { }
    };
};
