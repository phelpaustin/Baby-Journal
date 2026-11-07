import { createContext, useContext, useSyncExternalStore, useEffect, useState, useCallback } from "react";

export const SessionCtx = createContext(null);
export const useSession = () => useContext(SessionCtx);

export function useEngineState() {
  const { engine } = useSession();
  return useSyncExternalStore(engine.subscribe, engine.getState);
}
export function useQueueState() {
  const { queue } = useSession();
  return useSyncExternalStore(queue.subscribe, queue.getState);
}

// ---- hash router: #/path/segments
export function useHash() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}
export const go = (path) => { window.location.hash = path; };

// Runs an async loader now, again when `deps` change, and again when the engine or the
// media queue reports something new. Returns [value, reload, error].
export function useLoader(loader, deps, { watchEngine = false } = {}) {
  const { engine, queue, bus } = useSession();
  const [value, setValue] = useState(undefined);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let dead = false;
    Promise.resolve(loader())
      .then((v) => { if (!dead) { setValue(v); setError(null); } })
      .catch((e) => { if (!dead) setError(e); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  useEffect(() => {
    const offs = [bus.on("data-changed", reload)];
    if (watchEngine) offs.push(engine.subscribe(reload));
    return () => offs.forEach((f) => f());
  }, [engine, queue, bus, reload, watchEngine]);
  return [value, reload, error];
}

export function makeBus() {
  const t = new Map();
  return {
    on(name, fn) { if (!t.has(name)) t.set(name, new Set()); t.get(name).add(fn); return () => t.get(name).delete(fn); },
    emit(name) { (t.get(name) || []).forEach((f) => f()); },
  };
}
