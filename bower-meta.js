module.exports = {
  "angular": {
    "exports": "window.angular"
  },
  "bootstrap": {
    "componentMain": "dist/css/bootstrap.css"
  },
  "artTemplate": {
    "main": "dist/template.js",
    "mapping": [
      {
        "cwd": "dist",
        "src": "template.js",
        //"dest"
        "renameFn": function(target, config){
          return 'artTemplate.js';
        }
      }
    ]
  }
};