function optionalEnvironmentValue(name, environment = process.env) {
  const value = String(environment?.[name] ?? '').trim();
  return value && !/^(undefined|null)$/i.test(value) ? value : '';
}

function forwardEnvironment(source, names, target = process.env) {
  for (const name of names) {
    const candidate = source?.[name] || target?.[name];
    const normalized = String(candidate ?? '').trim();
    if (normalized && !/^(undefined|null)$/i.test(normalized)) {
      target[name] = candidate;
    } else {
      delete target[name];
    }
  }
}

module.exports = {
  forwardEnvironment,
  optionalEnvironmentValue,
};
