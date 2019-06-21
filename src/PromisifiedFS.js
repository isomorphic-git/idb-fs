const { encode, decode } = require("isomorphic-textencoder");
const debounce = require("just-debounce-it");

const Stat = require("./Stat.js");
const CacheFS = require("./CacheFS.js");
const { ENOENT, ENOTEMPTY } = require("./errors.js");
const IdbBackend = require("./IdbBackend.js");
const HttpBackend = require("./HttpBackend.js")
const Mutex = require("./Mutex.js");

const path = require("./path.js");
const clock = require("./clock.js");

function cleanParams(filepath, opts) {
  // normalize paths
  filepath = path.normalize(filepath);
  // strip out callbacks
  if (typeof opts === "undefined" || typeof opts === "function") {
    opts = {};
  }
  // expand string options to encoding options
  if (typeof opts === "string") {
    opts = {
      encoding: opts,
    };
  }
  return [filepath, opts];
}

function cleanParams2(oldFilepath, newFilepath) {
  // normalize paths
  return [path.normalize(oldFilepath), path.normalize(newFilepath)];
}

module.exports = class PromisifiedFS {
  constructor(name, { wipe, url } = {}) {
    this._idb = new IdbBackend(name);
    this._mutex = new Mutex(name);
    this._mutex.wait().then(success => console.log('GOT LOCK!', success))
    this._cache = new CacheFS(name);
    this._opts = { wipe, url };
    this.saveSuperblock = debounce(() => {
      this._saveSuperblock();
    }, 500);
    if (url) {
      this._http = new HttpBackend(url)
    }
    this._initPromise = this._init()
    this._operations = new Set()
    // Needed so things don't break if you destructure fs and pass individual functions around
    this.readFile = this._wrap(this.readFile)
    this.writeFile = this._wrap(this.writeFile)
    this.unlink = this._wrap(this.unlink)
    this.readdir = this._wrap(this.readdir)
    this.mkdir = this._wrap(this.mkdir)
    this.rmdir = this._wrap(this.rmdir)
    this.rename = this._wrap(this.rename)
    this.stat = this._wrap(this.stat)
    this.lstat = this._wrap(this.lstat)
    this.readlink = this._wrap(this.readlink)
    this.symlink = this._wrap(this.symlink)
  }
  _wrap (fn) {
    let tfn = async function (...args) {
      let op = {
        name: fn.name,
        args,
      }
      this._operations.add(op)
      try {
        return await fn.apply(this, args)
      } finally {
        this._operations.delete(op)
        // console.log(op)
        // console.log(this._operations.size + ' ops in flight')
      }
    }
    tfn.bind(this)
    return tfn
  }
  async _init() {
    if (this._initPromise) return this._initPromise
    if (this._opts.wipe) {
      await this._wipe();
    } else {
      await this._loadSuperblock();
    }
  }
  _wipe() {
    return this._idb.wipe().then(() => {
      if (this._http) {
        return this._http.loadSuperblock().then(text => {
          if (text) {
            this._cache.loadSuperBlock(text)
          }
        })
      }
     }).then(() => this._saveSuperblock());
  }
  _saveSuperblock() {
    return this._idb.saveSuperblock(this._cache._root);
  }
  _loadSuperblock() {
    return this._idb.loadSuperblock().then(root => {
      if (root) {
        this._cache.loadSuperBlock(root);
      } else if (this._http) {
        return this._http.loadSuperblock().then(text => {
          if (text) {
            this._cache.loadSuperBlock(text)
          }
        })
      }
    });
  }
  async readFile(filepath, opts) {
    await this._init()
    ;[filepath, opts] = cleanParams(filepath, opts);
    const { encoding } = opts;
    if (encoding && encoding !== 'utf8') throw new Error('Only "utf8" encoding is supported in readFile');
    const stat = this._cache.stat(filepath);
    let data = await this._idb.readFile(stat.ino)
    if (!data && this._http) {
      data = await this._http.readFile(filepath)
    }
    if (data && encoding === "utf8") {
        data = decode(data);
    }
    return data;
  }
  async writeFile(filepath, data, opts) {
    await this._init()
    ;[filepath, opts] = cleanParams(filepath, opts);
    const { mode, encoding = "utf8" } = opts;
    if (typeof data === "string") {
      if (encoding !== "utf8") {
        throw new Error('Only "utf8" encoding is supported in writeFile');
      }
      data = encode(data);
    }
    const stat = this._cache.writeFile(filepath, data, { mode });
    await this._idb.writeFile(stat.ino, data)
    this.saveSuperblock();
    return null
  }
  async unlink(filepath, opts) {
    await this._init()
    ;[filepath, opts] = cleanParams(filepath, opts);
    const stat = this._cache.stat(filepath);
    this._cache.unlink(filepath);
    await this._idb.unlink(stat.ino)
    this.saveSuperblock();
    return null
  }
  async readdir(filepath, opts) {
    await this._init()
    ;[filepath, opts] = cleanParams(filepath, opts);
    return this._cache.readdir(filepath);
  }
  async mkdir(filepath, opts) {
    await this._init()
    ;[filepath, opts] = cleanParams(filepath, opts);
    const { mode = 0o777 } = opts;
    await this._cache.mkdir(filepath, { mode });
    this.saveSuperblock();
    return null
  }
  async rmdir(filepath, opts) {
    await this._init()
    ;[filepath, opts] = cleanParams(filepath, opts);
    // Never allow deleting the root directory.
    if (filepath === "/") {
      throw new ENOTEMPTY();
    }
    this._cache.rmdir(filepath);
    this.saveSuperblock();
    return null;
  }
  async rename(oldFilepath, newFilepath) {
    await this._init()
    ;[oldFilepath, newFilepath] = cleanParams2(oldFilepath, newFilepath);
    this._cache.rename(oldFilepath, newFilepath);
    this.saveSuperblock();
    return null;
  }
  async stat(filepath, opts) {
    await this._init()
    ;[filepath, opts] = cleanParams(filepath, opts);
    const data = this._cache.stat(filepath);
    return new Stat(data);
  }
  async lstat(filepath, opts) {
    await this._init()
    ;[filepath, opts] = cleanParams(filepath, opts);
    let data = this._cache.lstat(filepath);
    return new Stat(data);
  }
  async readlink(filepath, opts) {
    await this._init()
    ;[filepath, opts] = cleanParams(filepath, opts);
    return this._cache.readlink(filepath);
  }
  async symlink(target, filepath) {
    await this._init()
    ;[target, filepath] = cleanParams2(target, filepath);
    this._cache.symlink(target, filepath);
    this.saveSuperblock();
    return null;
  }
}
