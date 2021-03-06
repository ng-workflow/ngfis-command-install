'use strict';

var util = require('util');
var path = require('path');
var fs = require('fs-extra');

var bower = require('bower');
var inquirer = require('inquirer');
var globby = require('globby');
var _ = require('lodash');

exports.name = 'install';
exports.usage = '[name] [name#version...] [options]';
exports.desc = 'install bower modules';
exports.register = function (commander){
  commander
    .option('-c, --clean', 'clean cached packages')
    .option('-d, --directory [path]', 'set install directory, default: `component_modules`')
    .option('--dev', 'also install project devDependencies')
    .option('--no-save', 'do not save installed packages into the project dependencies')
    .option('--save-dev', 'save installed packages into the project devDependencies')
    .action(function (){
      var args = Array.prototype.slice.call(arguments);
      var options = args.pop();

      if (options.clean){
        console.log('[Installer] clean bower cache.');
        bower.commands.cache.clean();
      }

      //read conf from fis-conf
      var conf = fis.config.get('settings.command.install') || {directory: 'component_modules'};

      //count paths
      var root = findRoot('fis-conf.js') || findRoot('bower.json');
      var directory = options.directory || conf.directory;
      var componentRoot = path.join(root, directory);

      //read project's component meta
      var projectMeta = getProjectMeta(root, directory);
      projectMeta.overrides = _.defaults(projectMeta.overrides || {}, require('./bower-meta'));

      //change `z=zepto#1.0.0` to 'zepto#1.0.0'
      var repo = args.map(function(name){
        var m = name.match(/([^=]+=)*(.*)/);
        return m[2];
      });

      var bowerOptions = {
        save: options.save && !options.saveDev,
        saveDev: options.saveDev,
        forceLatest: true,
        production: !options.dev
      };

      var bowerConfigs = {
        cwd: root,
        //Notify: if use full path, it will block.
        directory: directory,
        interactive: true
      };

      console.log('[Installer] bower install %s to: %s', repo, componentRoot);

      //start install
      var installer = bower.commands.install(repo, bowerOptions, bowerConfigs);
      installer.on('log', function (data){
        var endpoint = data.data.endpoint;
        var targetMsg = endpoint ? util.format('%s#%s', endpoint.name || endpoint.source, endpoint.target) : '';
        var str = util.format('   %s  %s %s', targetMsg, data.id, data.message);
        console.log(str);
      });
      installer.on('prompt', function (prompts, callback) {
        inquirer.prompt(prompts, callback);
      });
      installer.on("error", function (data){
        fis.log.error(data);
      });
      installer.on("end", function (installed) {
        simplify(installed, projectMeta, componentRoot);
      });
    });
};

/**
 * bubble search for fileName's parent
 * @param {String} fileName The config file name
 * @param {String} [basePath] The start path
 * @returns {*} Returns the directory where file at, or null
 */
function findRoot(fileName, basePath){
  var root = basePath || process.cwd();
  while(fs.existsSync(root)){
    if(fs.existsSync(path.join(root, fileName))){
      break;
    }else if(root === path.dirname(root)){
      root = null;
      break;
    }else{
      root = path.dirname(root);
    }
  }
  return root;
}


/**
 * read bower.json, if not exsit, create one using pkgInfo.
 * @param {String} root The start path
 * @param {String} directory The install path
 * @returns {*} Returns component meta.
 */
function getProjectMeta(root, directory){
  var metaPath = path.join(root, 'bower.json');
  var projectMeta = fs.readJsonSync(metaPath, {throws: false});
  if(!projectMeta){
    var pkgMeta = fs.readJsonSync(path.join(root, 'package.json'));
    projectMeta = {
      name: pkgMeta.name,
      private: true
    };
    console.log('[Installer] create bower.json');
    fs.writeJsonSync(metaPath, projectMeta);
    fs.writeJsonSync(path.join(root, '.bowerrc'), {"directory": directory});
  }
  return projectMeta;
}

/**
 * simplify component deps, using `meta.mapping`
 * @param {Object} installed The installed data from `bower.install`
 * @param {Object} projectMeta The project component meta
 * @param {String} componentRoot The component install path (full path)
 */
function simplify(installed, projectMeta, componentRoot){
  var ignore = projectMeta.ignoreDependencies || [];
  for(var key in installed) {
    //Notify: `bower install z=zepto#1.1.0`, then key=z, componentName=zepto
    if (installed.hasOwnProperty(key)) {
      if(ignore.indexOf(key) !== -1){
        console.log('[Installer] remove ignore: %s ...', key);
        fs.removeSync(path.join(componentRoot, key));
      }else{
        var item = installed[key];
        var componentName = key; //item.endpoint.source;
        console.log('[Installer] simplify %s ...', componentName);
        //merge meta: overrides -> buildinMeta -> own bower
        var meta = _.assign(item.pkgMeta, projectMeta.overrides && projectMeta.overrides[componentName]);
        syncFiles(key, meta, componentRoot, ignore);
      }
    }
  }
  console.log('[Installer] finish install: %s', _.difference(Object.keys(installed), ignore).join(' ') || 'nth need to install/update.');
}

/**
 * copy file by `meta.mapping`
 * @param {String} componentName The name of dep component
 * @param {Object} meta The component meta
 * @param {String} componentRoot The component install path (full path)
 * @param {Array} [ignore] The ignoreDependencies
 */
function syncFiles(componentName, meta, componentRoot, ignore){
  var srcDir = path.join(componentRoot, componentName);
  var targetDir = path.join(componentRoot, '.' + meta.name);
  var mapping = meta.mapping;

  //use `main` if mapping is null
  if(!mapping && meta.main){
    mapping = [];
    [].concat(meta.main).forEach(function(item, index){
      //move dist outside
      var m = item.match(/(\.\/)?(dist|release)\/(.*)/);
      if (m) {
        mapping.push({src: m[3], cwd: m[2]});
      } else {
        mapping.push(item);
      }
    });
  }

  if(mapping){
    //normalize mapping to glob style
    mapping.push('.bower.json', 'bower.json', 'component.json', 'package.json');
    var defaultPattens = ['!**/*.min.*', '!**/*.md'];
    var patterns = mapping.reduce(function (result, item) {
      if (typeof item === 'string') {
        result.push({
          cwd: './',
          src: [item].concat(defaultPattens),
          //dest: item
        });
      } else if (item.src) {
        item.cwd = item.cwd || './';
        item.src = [].concat(item.src, defaultPattens);
        if(typeof item.renameFn === 'string'){
          item.renameFn = new Function('targetFile, pattern', item.renameFn);
        }
        result.push(item);
      } else {
        console.warn('\tunknown mapping patten: ' + JSON.stringify(item));
      }
      return result;
    }, []);

    var mainList = [].concat(meta.main || []).map(function(item){
      return item.replace(/\.\//, '');
    });

    //sync files
    patterns.forEach(function (pattern) {
      //expand glob
      var files = globby.sync(pattern.src, {cwd: path.join(srcDir, pattern.cwd)});
      //copy files
      files.forEach(function (file) {
        var sourceFile = path.join(pattern.cwd, file).replace(/\\/g,'/');
        var targetFile = file.replace(/\\/g,'/');
        if (fs.statSync(path.join(srcDir, sourceFile)).isFile()) {
          if(pattern.rename){
            targetFile = pattern.rename;
          }else if(pattern.renameFn){
            targetFile = pattern.renameFn(targetFile, pattern);
          }
          console.log('    copy %s -> %s', sourceFile, targetFile);
          fs.copySync(path.join(srcDir, sourceFile), path.join(targetDir, targetFile));
        }
        //change main file to new path
        if(mainList.length > 0) {
          var index = mainList.indexOf(sourceFile);
          if (index !== -1) {
            mainList[index] = targetFile;
          }
        }

        //change componentMain file to new path
        //componentMain is use when your have multi main files.
        if(meta.componentMain && meta.componentMain === sourceFile) {
          meta.componentMain = targetFile;
        }
      });
    });

    //write to meta.main
    mainList = mainList.filter(function(item){
      return !!item;
    }).map(function(item){
      // './zepto.js' -> 'zepto.js'
      return item.replace(/^\.\//, '');
    });
    if(mainList.length > 0){
      meta.main = mainList.length === 1 ? mainList[0] : mainList;
    }

    //write meta
    meta._installedTime = new Date().getTime();
    meta = _.omit(meta, function(v, k){return k.indexOf('_')==0;});
    if(meta.dependencies){
      meta.dependencies = _.omit(meta.dependencies, ignore);
    }
    fs.writeJsonSync(path.join(targetDir, 'bower.json'), meta);

    //remove tmpDir
    fs.removeSync(srcDir);
    //move source to tmpDir
    fs.renameSync(targetDir, srcDir);
  }else{
    console.warn('%s missing meta.main & meta.mapping.', componentName);
  }
}
