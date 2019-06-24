const idb = require("@wmhilton/idb-keyval");

const sleep = ms => new Promise(r => setTimeout(r, ms))

const whoAmI = (typeof window === 'undefined' ? (self.name ? self.name : 'worker') : 'main' )+ ': '

module.exports = class Mutex {
  constructor(name) {
    this._id = Math.random()
    // console.log(whoAmI + this._id)
    this._database = name
    this._store = new idb.Store(this._database + "_lock", this._database + "_lock")
    this._has = false
    this._keepAliveTimeout = null
  }
  has () {
    return this._has
  }
  // Returns true if successful
  async acquire ({ ttl = 5000, refreshPeriod } = {}) {
    let success
    let expired
    let doubleLock
    await idb.update("lock", (current) => {
      const now = Date.now()
      expired = current && current.expires < now
      success = current === undefined || expired
      doubleLock = current && current.holder === this._id
      this._has = success || doubleLock
      return success ? { holder: this._id, expires: now + ttl } : current
    }, this._store)
    if (expired) {
      console.trace('LOCK EXPIRED?!')
    }
    if (doubleLock) {
      throw new Error('Mutex double-locked')
    }
    if (success) {
      this._keepAlive({ ttl, refreshPeriod })
    }
    return success
  }
  // check at 10Hz, give up after 10 minutes
  async wait ({ interval = 100, limit = 6000, ttl, refreshPeriod } = {}) {
    while (limit--) {
      if (await this.acquire({ ttl, refreshPeriod })) return true
      await sleep(interval)
    }
    throw new Error('Mutex timeout')
  }
  // Returns true if successful
  async release ({ force = false } = {}) {
    let success
    let doubleFree
    let someoneElseHasIt
    this._stopKeepAlive()
    await idb.update("lock", (current) => {
      success = force || (current && current.holder === this._id)
      doubleFree = current === void 0
      someoneElseHasIt = current && current.holder !== this._id
      this._has = !success
      return success ? void 0 : current
    }, this._store)
    if (!this._has) {
      await idb.close(this._store)
    }
    if (!success && !force) {
      if (doubleFree) throw new Error('Mutex double-freed')
      if (someoneElseHasIt) throw new Error('Mutex lost ownership')
    }
    return success
  }
  async _keepAlive ({ ttl = 1000, refreshPeriod = Math.max(ttl * 0.8 - 600, 10) } = {}) {
    const keepAliveFn = async () => {
      let success
      let someoneDeletedIt
      let someoneElseHasIt
      await idb.update("lock", (current) => {
        const now = Date.now()
        console.log(whoAmI + 'with', current && (current.expires - now), 'ms to spare')
        someoneDeletedIt = current === void 0
        someoneElseHasIt = current && current.holder !== this._id
        success = !someoneDeletedIt && !someoneElseHasIt
        this._has = success
        return success ? { holder: this._id, expires: now + ttl } : current
      }, this._store)
      if (!success) this._stopKeepAlive()
      if (someoneDeletedIt) throw new Error('Mutex was deleted')
      if (someoneElseHasIt) throw new Error('Mutex lost ownership')
    }
    this._keepAliveTimeout = setInterval(keepAliveFn, refreshPeriod)
  }
  _stopKeepAlive () {
    if (this._keepAliveTimeout) {
      clearInterval(this._keepAliveTimeout)
    }
  }
}
