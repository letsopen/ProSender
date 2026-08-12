// 极简事件发射器
export default class Emitter {
  constructor() {
    this._events = {};
  }

  on(name, cb) {
    (this._events[name] = this._events[name] || []).push(cb);
    return this;
  }

  off(name, cb) {
    const list = this._events[name];
    if (!list) return this;
    if (!cb) {
      delete this._events[name];
      return this;
    }
    const idx = list.indexOf(cb);
    if (idx >= 0) list.splice(idx, 1);
    return this;
  }

  emit(name, payload) {
    const list = this._events[name];
    if (!list) return;
    list.slice().forEach((cb) => {
      try {
        cb(payload);
      } catch (e) {
        console.error(`[lan] event ${name} handler error`, e);
      }
    });
  }
}
