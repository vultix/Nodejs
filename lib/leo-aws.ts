let paths = module.paths;
module.paths = require('module')._nodeModulePaths(process.cwd());
let aws = require("aws-sdk") as typeof import('aws-sdk');
module.paths = paths;
export default aws;
