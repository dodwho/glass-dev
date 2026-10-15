const { createDhis2Proxy } = require("../config/dhis2-proxy");

// react-scripts runs src/setupProxy.js when the development server starts. See config/dhis2-proxy.js.
module.exports = function (app) {
    app.use(createDhis2Proxy());
};
