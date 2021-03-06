var gulp = require('gulp');
var fs = require('fs');
var path = require('path');
var run = require('run-sequence');
var merge = require('merge-stream');
var del = require('del');
var exec = require('child_process').exec;
var replace = require('gulp-replace');
var rename = require('gulp-rename');
var concat = require('gulp-concat');
var uglify = require('gulp-uglify');
var stylus = require('gulp-stylus');
var cssnano = require('gulp-cssnano');
var babel = require('gulp-babel');
var DataURI = require('datauri');
var marked = require('marked');
var cheerio = require('cheerio');
var pack = require('./package.json');
var version = pack.version;

function getCommentHandler() {
  var inMetaBlock = false;
  return function (node, comment) {
    var value = comment.value.trim();
    if (comment.type === 'comment2' && value.charAt(0) === '!') {
      return true;
    }
    if (value === '==UserScript==') {
      inMetaBlock = true;
      return true;
    }
    if (value === '==/UserScript==') {
      inMetaBlock = false;
      return true;
    }
    return inMetaBlock;
  }
}

gulp.task('css:prepare', function () {
  return gulp.src('./src/tooltipster.css')
    .pipe(replace(
      'spinner.gif', new DataURI('./assets/spinner.gif').content
    ))
    .pipe(gulp.dest('./tmp'));
});

gulp.task('css:compile', function () {
  return gulp.src('./src/*.styl')
    .pipe(stylus())
    .pipe(gulp.dest('./src'));
});

gulp.task('css', ['css:prepare', 'css:compile']);

gulp.task('resource:inline', function () {
  return gulp.src('./src/hovercard.js')
    .pipe(replace('\'__OCTICONS__\'', JSON.stringify(require('./assets/octicons.json'))))
    .pipe(replace('\'__EMOJI_DATA__\'', JSON.stringify(require('./assets/emoji.json'))))
    .pipe(gulp.dest('./tmp'));
});

gulp.task('firefox:resource', function () {
  return gulp.src('./src/hovercard.js')
    .pipe(replace('\'__OCTICONS__\'', 'self.options.octicons'))
    .pipe(replace('\'__EMOJI_DATA__\'', 'self.options.emojiMap'))
    .pipe(rename('hovercard.firefox.js'))
    .pipe(gulp.dest('./tmp'));
});

gulp.task('userscript:prepare', ['resource:inline'], function () {
  var hovercard = gulp.src('./tmp/hovercard.js')
    .pipe(babel({ presets: ['es2015'] }))
    .pipe(rename('hovercard.userscript.js'))
    .pipe(gulp.dest('./tmp'));
  var meta = gulp.src('./userscript/src/metadata.js')
    .pipe(replace('{{version}}', version))
    .pipe(gulp.dest('./tmp'));
  return merge(hovercard, meta);
});

gulp.task('userscript:styles', ['css'], function () {
  return gulp.src([
      './tmp/tooltipster.css',
      './src/hovercard.css',
      './src/tomorrow-night.css'
    ])
    .pipe(concat('userscript.css'))
    .pipe(cssnano({ zindex: false }))
    .pipe(gulp.dest('./tmp'));
});

gulp.task('userscript:inject-styles', ['userscript:styles'], function () {
  return gulp.src('./userscript/src/inject-styles.js')
    .pipe(replace('__USER_SCRIPT_STYLES__', fs.readFileSync('./tmp/userscript.css', { encoding: 'utf8' }).replace(/'/g, '\\\'')))
    .pipe(gulp.dest('./tmp'));
});

gulp.task('userscript', ['userscript:inject-styles', 'userscript:prepare'], function () {
  var inMetaBlock = false;
  return gulp.src([
      './tmp/metadata.js',
      './tmp/inject-styles.js',
      './src/jquery.js',
      './src/mustache.js',
      './src/tooltipster.js',
      './tmp/hovercard.userscript.js'
    ])
    .pipe(concat('github-hovercard.user.js'))
    .pipe(uglify({
      preserveComments: getCommentHandler()
    }))
    .pipe(gulp.dest('./userscript/dist'));
});

gulp.task('chrome:cp', ['resource:inline', 'css'], function () {
  var targets = [
    './src/*', '!./src/hovercard.js', './tmp/hovercard.js',
    '!./src/*.styl', '!./src/tooltipster.css', './tmp/tooltipster.css'
  ];
  var src = gulp.src(targets)
    .pipe(gulp.dest('./extensions/chrome'));
  var icon = gulp.src('./icon.png')
    .pipe(gulp.dest('./extensions/chrome'));
  return merge(src, icon);
});

gulp.task('firefox:cp', ['firefox:resource', 'css'], function () {
  var targets = [
    './src/*', '!./src/hovercard.js',
    '!./src/*.styl', '!./src/tooltipster.css', './tmp/tooltipster.css'
  ];
  var main = gulp.src(['./tmp/hovercard.firefox.js'])
    .pipe(rename('hovercard.js'))
    .pipe(gulp.dest('./extensions/firefox/data'));
  var src = gulp.src(targets.concat([
      './assets/emoji.json', './assets/octicons.json'
    ]))
    .pipe(gulp.dest('./extensions/firefox/data'));
  var icon = gulp.src('./icon.png')
    .pipe(gulp.dest('./extensions/firefox'))
  return merge(main, src, icon);
});

gulp.task('chrome:zip', ['chrome:cp'], function (cb) {
  var manifestPath = './extensions/chrome/manifest.json';
  var manifest = JSON.parse(fs.readFileSync(manifestPath, { encoding: 'utf8' }));
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '  '));
  exec(
    'find . -path \'*/.*\' -prune -o -type f -print | zip ../packed/github-hovercard.zip -@',
    { cwd: 'extensions/chrome' },
    function (error, stdout, stderr) {
      if (error) {
        return cb(error);
      } else {
        cb();
      }
    }
  );
});

gulp.task('firefox:xpi', ['firefox:cp'], function (cb) {
  var fxPackPath = './extensions/firefox/package.json';
  var fxPack = JSON.parse(fs.readFileSync(fxPackPath, { encoding: 'utf8' }));
  fxPack.version = version;
  fs.writeFileSync(fxPackPath, JSON.stringify(fxPack, null, '  '));
  exec('jpm xpi', {
    cwd: 'extensions/firefox'
  }, function (error, stdout, stderr) {
    if (error) {
      return cb(error);
    } else {
      fs.renameSync('./extensions/firefox/@' + pack.name + '-' + version + '.xpi', './extensions/packed/' + pack.name + '.xpi');
      cb();
    }
  });
});

gulp.task('opera:nex', ['chrome:zip'], function (cb) {
  exec(''
    + '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"'
    + ' --pack-extension=' + path.join(__dirname, 'extensions/chrome')
    + ' --pack-extension-key=' + path.join(process.env.HOME, '.ssh/chrome.pem'),
    function (error, stdout, stderr) {
      if (error) {
        return cb(error);
      } else {
        fs.renameSync('./extensions/chrome.crx', './extensions/packed/github-hovercard.nex');
        cb();
      }
    }
  );
});

gulp.task('demo:prepare', ['resource:inline'], function () {
  var hovercard = gulp.src('./tmp/hovercard.js')
    .pipe(replace('location.host', '\'github.com\''))
    .pipe(babel({ presets: ['es2015'] }))
    .pipe(rename('hovercard.demo.js'))
    .pipe(gulp.dest('./tmp'));

  var demo = gulp.src('./demo/src/demo.js')
    .pipe(babel({ presets: ['es2015'] }))
    .pipe(gulp.dest('./tmp'));

  return merge(hovercard, demo);
});

gulp.task('demo:index', function () {
  var changelog = fs.readFileSync('./CHANGELOG.md', { encoding: 'utf8' });
  var $ = cheerio.load(marked(changelog));

  return gulp.src('./demo/src/index.html')
    .pipe(replace('${version}', version))
    .pipe(replace('${changes}', '<ul>' + $('h2').eq(1).next().html() + '</ul>'))
    .pipe(gulp.dest('.'));
});

gulp.task('demo', ['css', 'demo:prepare', 'demo:index'], function () {
  var jsSrc = gulp.src([
      './src/jquery.js',
      './src/mustache.js',
      './src/tooltipster.js',
      './tmp/hovercard.demo.js',
      './tmp/demo.js'
    ])
    .pipe(concat('demo.js'))
    .pipe(uglify({
      preserveComments: getCommentHandler()
    }))
    .pipe(gulp.dest('./demo/dist'));

  var cssSrc = gulp.src([
      './tmp/tooltipster.css',
      './src/hovercard.css',
      './src/tomorrow-night.css',
      './demo/src/demo.css'
    ])
    .pipe(concat('demo.css'))
    .pipe(cssnano({ zindex: false }))
    .pipe(gulp.dest('./demo/dist'));

  return merge(jsSrc, cssSrc);
});

gulp.task('cleanup', function (cb) {
  return del(['./tmp']);
});

gulp.task('extensions', ['chrome:zip', 'firefox:xpi', 'opera:nex']);
gulp.task('build', ['extensions', 'demo', 'userscript']);
gulp.task('default', function (cb) {
  run('build', 'cleanup', cb);
});
