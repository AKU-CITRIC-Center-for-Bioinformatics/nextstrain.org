const __fetch = require("make-fetch-happen");
const utils = require("./utils");

const FETCH_OPTIONS = Symbol("Request options for make-fetch-happen");

const _fetch = __fetch.defaults({
  cache: "default",
  cacheManager: process.env.FETCH_CACHE || "/tmp/fetch-cache",
});

const fetch = async (url, options) => {
  const request = new Request(url, options);

  utils.verbose(`[fetch] ${request.method} ${request.url} (cache: ${request.cache})`);

  const response = await _fetch(request, request[FETCH_OPTIONS]);
  const cachedAt = response.headers.get("X-Local-Cache-Time"); // documented by make-fetch-happen
  const cachedStatus = response.headers.get("X-Local-Cache-Status"); // documented by make-fetch-happen

  utils.verbose(`[fetch] ${response.status} ${response.statusText} ${response.url} ${(cachedAt || cachedStatus) ? `(cache ${cachedStatus}, timestamp ${cachedAt})` : ''}`);

  return response;
};

class Request extends __fetch.Request {
  // XXX FIXME
  constructor (input, init = {}) {
    super(input, init);

    this[FETCH_OPTIONS] = input instanceof Request
      ? {...input[FETCH_OPTIONS], ...init}
      : init;
  }

  get cache() { return this[FETCH_OPTIONS].cache }
}

module.exports = {
  fetch,
  Request,
};
