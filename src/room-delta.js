const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

function valuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.hasOwn(right, key) && valuesEqual(left[key], right[key]));
  }
  return false;
}

/**
 * Produces compact, JSON-safe operations. Arrays are compared item by item, so
 * drawing one card normally sends one append operation instead of the room.
 */
export function createRoomDelta(previous, next, path = []) {
  if (valuesEqual(previous, next)) return [];
  if (Array.isArray(previous) && Array.isArray(next)) {
    const operations = [];
    const commonLength = Math.min(previous.length, next.length);
    for (let index = 0; index < commonLength; index += 1) {
      operations.push(...createRoomDelta(previous[index], next[index], [...path, index]));
    }
    for (let index = previous.length - 1; index >= next.length; index -= 1) {
      operations.push({ op: "remove", path: [...path, index] });
    }
    for (let index = commonLength; index < next.length; index += 1) {
      operations.push({ op: "set", path: [...path, index], value: next[index] });
    }
    return operations;
  }
  if (isRecord(previous) && isRecord(next)) {
    const operations = [];
    for (const key of Object.keys(previous)) {
      if (!Object.hasOwn(next, key)) operations.push({ op: "remove", path: [...path, key] });
    }
    for (const [key, value] of Object.entries(next)) {
      if (!Object.hasOwn(previous, key)) operations.push({ op: "set", path: [...path, key], value });
      else operations.push(...createRoomDelta(previous[key], value, [...path, key]));
    }
    return operations;
  }
  return [{ op: "set", path, value: next }];
}

// Exported for protocol tests and tooling. Production clients apply operations.
export function applyRoomDelta(state, operations) {
  const result = structuredClone(state);
  for (const operation of operations) {
    let target = result;
    for (let index = 0; index < operation.path.length - 1; index += 1) target = target[operation.path[index]];
    const key = operation.path.at(-1);
    if (operation.op === "remove") {
      if (Array.isArray(target)) target.splice(key, 1);
      else delete target[key];
    } else if (Array.isArray(target) && key === target.length) target.push(structuredClone(operation.value));
    else target[key] = structuredClone(operation.value);
  }
  return result;
}
