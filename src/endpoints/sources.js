const {parse: parseContentType} = require("content-type");
const {Forbidden, InternalServerError, NotFound, Unauthorized} = require("http-errors");
const negotiateMediaType = require("negotiator/lib/mediaType");
const stream = require("stream");
const {promisify} = require("util");

const {contentTypesProvided, contentTypesConsumed} = require("../negotiate");
const {fetch, Request} = require("../fetch");
const sources = require("../sources");
const utils = require("../utils");
const {sendAuspiceEntrypoint} = require("./static");


/* XXX TODO: Replace promisify() with require("stream/promises") once we
 * upgrade to Node 14+.
 *   -trs, 5 Nov 2021
 */
const pipeline = promisify(stream.pipeline);


/**
 * Generate Express middleware that instantiates a {@link Source} instance and
 * stashes it in the request context.
 *
 * @param {String} sourceName - Name of a source (from `src/sources.js`)
 * @param {argsExtractor} [argsExtractor] - Function to extract {@link Source}
 *   constructor arguments from the request
 * @returns {expressHandler}
 */
// eslint-disable-next-line no-unused-vars
const setSource = (sourceName, argsExtractor = (req) => []) => (req, res, next) => {
  const Source = sources.get(sourceName);

  if (!Source) throw new NotFound();

  const source = new Source(...argsExtractor(req));

  res.vary("Accept");

  if (!source.visibleToUser(req.user)) {
    if (!req.user) {
      if (req.accepts("html")) {
        utils.verbose(`Redirecting anonymous user to login page from ${req.originalUrl}`);
        req.session.afterLoginReturnTo = req.originalUrl;
        return res.redirect("/login");
      }
      throw new Unauthorized();
    }
    throw new Forbidden();
  }

  req.context.source = source;
  return next();
};


/* XXX TODO: Remove setGroupSource() once we move from one source per group to
 * one source parameterized by group name, which will enable us to use the
 * standard setSource() like so:
 *
 *    app.use("/groups/:groupName", setSource("group", req => req.params.groupName))
 *
 *   -trs, 25 Oct 2021
 */
/**
 * Generate Express middleware that instantiates a {@link Source} instance for
 * a group and stashes it in the request context.
 *
 * @param {nameExtractor} nameExtractor - Function to extract the group name from the request
 * @returns {expressHandler}
 */
const setGroupSource = (nameExtractor) => (req, res, next) => {
  const groupName = nameExtractor(req);
  const Source = sources.get(groupName);

  // Don't allow group names that happen to be non-group source names.
  if (!Source || !Source.isGroup()) throw new NotFound();

  return setSource(groupName)(req, res, next);
};


/* Datasets
 */

/**
 * Generate Express middleware that instantiates a {@link Dataset} instance and
 * stashes it in the request context.
 *
 * @param {pathExtractor} pathExtractor - Function to extract a dataset path from the request
 * @returns {expressHandler}
 */
const setDataset = (pathExtractor) => (req, res, next) => {
  req.context.dataset = req.context.source.dataset(pathParts(pathExtractor(req)));
  next();
};


/**
 * Generate Express middleware that redirects to the canonical path for the
 * current {@link Dataset} if it is not fully resolved.
 *
 * @param {pathBuilder} pathBuilder - Function to build a fully-specified path
 * @returns {expressHandler}
 */
const canonicalizeDataset = (pathBuilder) => (req, res, next) => {
  const dataset = req.context.dataset;
  const resolvedDataset = dataset.resolve();

  if (dataset === resolvedDataset) return next();

  /* 307 Temporary Redirect preserves request method, unlike 302 Found, which
   * is important since this middleware function may be used in non-GET routes.
   */
  return res.redirect(307, pathBuilder(resolvedDataset.pathParts.join("/")));
};


/**
 * Express middleware function that throws a {@link NotFound} error if {@link
 * Dataset#exists} returns false.
 *
 * @type {asyncExpressHandler}
 */
const ifDatasetExists = async (req, res, next) => {
  if (!(await req.context.dataset.exists())) throw new NotFound();
  return next();
};


/**
 * XXX FIXME: is ${type} reasonable here?
 *
 * @param 
 * @returns {asyncExpressHandler}
 */
const sendDatasetSubresource = type => async (req, res) => {
  const dataset = req.context.dataset;
  const subresourceUrl = await dataset.urlFor(type);

  // XXX FIXME: for main, handle only meta + tree existing and combining them?

  /* Happy path of upstream CORS support means we can just redirect the client
   * to have it fetch the data directly.
   *
   * In doing so, we give up direct ability to control the ultimate response
   * the client receives (although we often own the upstream source too).  This
   * manifests, for example, as the client receiving whatever Content-Type the
   * upstream sends, instead of verifying it ourselves.  Or another example:
   * the upstream 404s and other errors received by the client probably won't
   * be JSON like ours.  It still seems worth it to use CORS when we can, but
   * maybe in the future the costs of inconsistency or new needs arising will
   * tip the balance in favor of always proxying.
   *   -trs, 9 Nov 2021
   */
  if (dataset.source.supportsCors) {
    return res.redirect(subresourceUrl);
  }

  /* Without upstream CORS support, we need to proxy the data through us:
   *
   *    client (browser, CLI, etc) ⟷ us (nextstrain.org) ⟷ upstream source
   *
   * Use "no-cache" mode to always revalidate with the upstream but avoid
   * re-transferring the content if we have a cached copy that matches
   * upstream.
   */
  return await proxyFetch(res, new Request(subresourceUrl, {
    headers: {
      Accept: [
        `application/vnd.nextstrain.${type}+json`,
        "application/json; q=0.9",
        "text/plain; q=0.1",
      ].join(", ")
    },
    cache: "no-cache",
  }));
}


const getDatasetSubresource = type => contentTypesProvided([
  [`application/vnd.nextstrain.${type}+json`, sendDatasetSubresource(type)],
  ["application/json", sendDatasetSubresource(type)],
]);


const getDatasetMain           = getDatasetSubresource("main");
const getDatasetRootSequence   = getDatasetSubresource("root-sequence");
const getDatasetTipFrequencies = getDatasetSubresource("tip-frequencies");


const getDataset = contentTypesProvided([
  ["text/html", ifDatasetExists, sendAuspiceEntrypoint],
  ["application/json", getDatasetMain],
  ["application/vnd.nextstrain.main+json", getDatasetMain],
  ["application/vnd.nextstrain.root-sequence+json", getDatasetRootSequence],
  ["application/vnd.nextstrain.tip-frequencies+json", getDatasetTipFrequencies],
  /* XXX FIXME?
  ["application/vnd.nextstrain.meta+json", ...],
  ["application/vnd.nextstrain.tree+json", ...],
  */
]);



const putDatasetMainV2 = async (req, res) => {
  // XXX FIXME
  //    await req.context.dataset.put("main", req) ???
  return res.redirect(307, await req.context.dataset.urlFor("main", "PUT"));
};

const putDatasetMain = contentTypesConsumed([
  ["application/vnd.nextstrain.main+json", putDatasetMainV2],
  ["application/json", putDatasetMainV2],
]);


const putDatasetRootSequenceVX = async (req, res) => {
  // XXX FIXME
  //    await req.context.dataset.put("main", req) ???
  return res.redirect(307, await req.context.dataset.urlFor("root-sequence", "PUT"));
};

const putDatasetRootSequence = contentTypesProvided([
  ["application/vnd.nextstrain.root-sequence+json", putDatasetRootSequenceVX],
  ["application/json", putDatasetRootSequenceVX],
]);


const putDataset = contentTypesConsumed([
  ["application/json", putDatasetMain],
  ["application/vnd.nextstrain.main+json", putDatasetMain],
  ["application/vnd.nextstrain.root-sequence+json", putDatasetRootSequence],
  /*
  ["application/vnd.nextstrain.tip-frequencies+json", ...],
  ["application/vnd.nextstrain.meta+json", ...],
  ["application/vnd.nextstrain.tree+json", ...],
  */
]);


/* Narratives
 */

/**
 * Generate Express middleware that instantiates a {@link Narrative} instance
 * and stashes it in the request context.
 *
 * @param {pathExtractor} pathExtractor - Function to extract a narrative path from the request
 * @returns {expressHandler}
 */
const setNarrative = (pathExtractor) => (req, res, next) => {
  req.context.narrative = req.context.source.narrative(pathParts(pathExtractor(req)));
  next();
};


/**
 * Express middleware function that throws a {@link NotFound} error if {@link
 * Narrative#exists} returns false.
 *
 * @type {expressHandler}
 */
const ifNarrativeExists = async (req, res, next) => {
  if (!(await req.context.narrative.exists())) throw new NotFound();
  return next();
};


/**
 * XXX FIXME
 *
 * @param 
 * @returns {asyncExpressHandler}
 */
const getNarrativeMarkdown = async (req, res) => {
  const narrative = req.context.narrative;
  const narrativeUrl = await narrative.url();

  // XXX FIXME comments from getDatasetSubresource
  if (narrative.source.supportsCors) {
    return res.redirect(narrativeUrl);
  }

  return await proxyFetch(res, new Request(narrativeUrl, {
    headers: {
      Accept: [
        "text/markdown",
        "text/*; q=0.1",
      ].join(", ")
    },
    cache: "no-cache",
  }));
}


const getNarrative = contentTypesProvided([
  ["text/html", ifNarrativeExists, sendAuspiceEntrypoint],
  ["text/markdown", getNarrativeMarkdown],
]);


/**
 * Split a dataset or narrative `path` into an array of parts.
 *
 * If `path` is a tangletree path (i.e. refers to two datasets), returns only
 * the parts for the first dataset.
 *
 * @param {String} path
 * @returns {String[]}
 */
function pathParts(path = "") {
  const normalizedPath = path
    .split(":")[0]          // Use only the first dataset in a tangletree (dual dataset) path.
    .replace(/^\/+/, "")    // Ignore leading slashes
    .replace(/\/+$/, "")    //   …and trailing slashes.
  ;

  if (!normalizedPath) return [];

  return normalizedPath.split("/");
}


/**
 * XXX FIXME
 *
 * @param {express.response} res - Express-style response instance
 * @param {Response} upstreamReq - Request instance (WHATWG fetch()-style) for
 *    the upstream resource
 */
async function proxyFetch(res, upstreamReq) {
  const upstreamRes = await fetch(upstreamReq);

  switch (upstreamRes.status) {
    case 200:
    case 304:
      break;

    case 403:
    case 404:
      throw new NotFound();

    default:
      throw new InternalServerError(upstreamRes);
  }

  /* Check that the upstream returned something acceptable to us.  This ensures
   * we honor the content negotiation for our own response.
   */
  const accept      = upstreamReq.headers.get("Accept");
  const contentType = upstreamRes.headers.get("Content-Type");

  if (!acceptableContentType(accept, contentType)) {
    throw new InternalServerError(`source response has unacceptable Content-Type: ${contentType}`);
  }

  await pipeline(upstreamRes.body, res);
  return res.end();
}


/**
 * XXX FIXME
 *
 * @returns {boolean}
 */
function acceptableContentType(accept, contentType) {
  if (!accept) return true;
  if (!contentType) return false;

  let mediaType;

  try {
    mediaType = parseContentType(contentType).type;
  } catch (err) {
    // parseContentType() throws a TypeError if contentType is bogus
    if (!(err instanceof TypeError)) {
      throw err;
    }
  }

  if (!mediaType) return false;

  return negotiateMediaType(accept, [mediaType]).length > 0;
}


/**
 * @callback argsExtractor
 * @param {express.request} req
 * @returns {Array} Arguments for a {@link Source} constructor.
 */

/**
 * @callback nameExtractor
 * @param {express.request} req
 * @returns {String} Name of a Group
 */

/**
 * @callback pathExtractor
 * @param {express.request} req
 * @returns {String} Path for {@link Source#dataset} or {@link Source#narrative}
 */

/**
 * @callback pathBuilder
 * @param {String} path - Canonical path for the dataset within the context of
 *   the current {@link Source}
 * @returns {String} Fully-specified path to redirect to
 */

/**
 * @callback expressHandler
 * @param {express.request} req
 * @param {express.response} res
 * @param {Function} [next]
 */

/**
 * @callback asyncExpressHandler
 * @async
 * @param {express.request} req
 * @param {express.response} res
 * @param {Function} [next]
 */



module.exports = {
  setSource,
  setGroupSource,

  setDataset,
  canonicalizeDataset,
  ifDatasetExists,
  getDataset,
  getDatasetMain,
  getDatasetRootSequence,
  getDatasetTipFrequencies,
  putDataset,
  putDatasetMain,
  putDatasetRootSequence,

  setNarrative,
  ifNarrativeExists,
  getNarrative,
  getNarrativeMarkdown,
};
