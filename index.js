const path = require('path');
const fse = require('fs-extra');
const util = require('util');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const _ = require('lodash');
const { getSetupForPage, getSetupForProp } = require('./lib/setup');

const pkg = require('./package.json');


module.exports.name = pkg.name;

const eventEmitter = new EventEmitter();
const isDev = process.env.NODE_ENV === 'development';

const LIVE_UPDATE_EVENT_NAME = 'props_changed';
const DEFAULT_FILE_CACHE_PATH = path.join(process.cwd(), '.sourcebit-nextjs-cache.json');
const DEFAULT_LIVE_UPDATE_PORT = 8088;


function startStaticPropsWatcher({ wsPort }) {
    const wss = new WebSocket.Server({ path: '/nextjs-live-updates', port: wsPort });

    wss.on('connection', (ws) => {
        console.log('[data-listener] websocket connected');
        ws.on('message', (message) => {
            console.log('[data-listener] websocket received message:', message);
        });
        ws.on('close', () => {
            console.log('[data-listener] websocket disconnected');
        });
        eventEmitter.on(LIVE_UPDATE_EVENT_NAME, () => {
            console.log(`[data-listener] websocket send '${LIVE_UPDATE_EVENT_NAME}'`);
            ws.send(LIVE_UPDATE_EVENT_NAME);
        });
        console.log('[data-listener] send "hello"');
        ws.send('hello');
    });
}

function reduceAndTransformData(data, { commonProps, pages }) {
    return {
        props: reducePropsMap(commonProps, data),
        pages: reducePages(pages, data)
    };
}

function reducePages(pages, data) {
    if (typeof pages === 'function') {
        const pageObjects = pages(data);

        return _.reduce(pageObjects, (accum, item) => {
            let urlPath;
            try {
                urlPath = interpolatePagePath(item.path, item.page);
            } catch (e) {
                return accum;
            }

            return _.concat(accum, _.assign(
                item, { path: urlPath }
            ));
        }, [])
    }

    return _.reduce(pages, (accum, pageTypeDef) => {
        const pages = _.filter(data, pageTypeDef.predicate);
        const pathTemplate = pageTypeDef.path || '/{slug}';
        return _.reduce(pages, (accum, page) => {
            let urlPath;
            try {
                urlPath = interpolatePagePath(pathTemplate, page);
            } catch (e) {
                return accum;
            }
            return _.concat(accum, {
                path: urlPath,
                page: page,
                ...reducePropsMap(pageTypeDef.props, data)
            });
        }, accum)
    }, []);
}

function reducePropsMap(propsMap, data) {
    if (typeof propsMap === 'function') {
        return propsMap(data)
    }

    return _.reduce(propsMap, (accum, propDef, propName) => {
        if (_.get(propDef, 'single')) {
            return _.assign({}, accum,  {[propName]: _.find(data, propDef.predicate)});
        } else {
            return _.assign({}, accum,  {[propName]: _.filter(data, propDef.predicate)});
        }
    }, {});
}

function interpolatePagePath(pathTemplate, page) {
    let urlPath = pathTemplate.replace(/{([\s\S]+?)}/g, (match, p1) => {
        const fieldValue = _.get(page, p1);
        if (!fieldValue) {
            throw new Error(`page has no value in field '${p1}', page: ${util.inspect(page, {depth: 0})}`);
        }
        return _.trim(fieldValue, '/');
    });

    if (!_.startsWith(urlPath, '/')) {
        urlPath = '/' + urlPath;
    }

    return urlPath;
}

module.exports.getOptionsFromSetup = ({ answers, debug }) => {
    const options = {};
    const pageBranches = answers.pages.map(page => {
        if (!page.__model) return null;

        const conditions = [
            page.__model.modelName && `(object.__metadata.modelName === '${page.__model.modelName}')`,
            page.__model.source && `(object.__metadata.source === '${page.__model.source}')`
        ].filter(Boolean).join(' && ');

        return `  if (${conditions}) {
    return pages.concat({ path: '${page.pagePath}', page: object });
  }`
    })
    const functionBody = `return objects.reduce((pages, object) => {
${pageBranches.join('\n\n')}

  return pages;
}, [])`;

    debug(functionBody);

    options.pages = new Function("objects", functionBody);

    const commonProps = answers.commonProps.reduce((commonProps, propObject) => {
        if (!propObject.__model) return commonProps;

        if (propObject.isMultiple) {
            return commonProps.concat(`${propObject.propName}: objects.reduce((acc, object) => object.__metadata.modelName === '${propObject.__model.modelName}' ? acc.concat(object) : acc, [])`)
        }

        return commonProps.concat(`${propObject.propName}: objects.find(object => object.__metadata.modelName === '${propObject.__model.modelName}')`)
    }, []);

    if (commonProps.length > 0) {
        const functionBody = `return {
  ${commonProps.join(',\n  ')}
}`

        options.commonProps = new Function("objects", functionBody);
    }

    return options;    
}

module.exports.getSetup = ({ chalk, data, inquirer, log }) => {
  return async () => {
    // We want to exclude the internal `__asset` model from the options.
    const models = data.models.filter(model => model.modelName !== '__asset');
    const { pageModels: pageModelIndexes } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "pageModels",
        message: "Which of these models should generate a page?",
        choices: models.map((model, index) => ({
            name: `${model.modelLabel || model.modelName} ${chalk.dim(`(${model.source})`)}`,
            short: model.modelLabel || model.modelName,
            value: index
        }))
      }
    ]);
    const pageModels = pageModelIndexes.map(index => models[index]);

    let queue = Promise.resolve({ commonProps: [], pages: [] });

    pageModels.forEach((model, index) => {
        queue = queue.then(async setupData => {
            console.log(
                `\nConfiguring page: ${chalk.bold(
                    model.modelLabel || model.modelName
                )} ${chalk.reset.italic.green(
                    `(${index + 1} of ${pageModels.length}`
                )})`
            );
  
            return getSetupForPage({ chalk, data, inquirer, model, setupData });
        });
    });

    await queue;

    console.log('');

    const { propModels: propModelIndexes } = await inquirer.prompt([
        {
            type: "checkbox",
            name: "propModels",
            message: "Which of these models do you want to include as props to all page components?",
            choices: models.map((model, index) => ({
                name: `${model.modelLabel || model.modelName} ${chalk.dim(`(${model.source})`)}`,
                short: model.modelLabel || model.modelName,
                value: index
            }))
        }
    ]);
    const propModels = propModelIndexes.map(index => models[index]);

    propModels.forEach((model, index) => {
        queue = queue.then(async setupData => {
            console.log(
                `\nConfiguring common prop: ${chalk.bold(
                    model.modelLabel || model.modelName
                )} ${chalk.reset.italic.green(
                    `(${index + 1} of ${propModels.length}`
                )})`
            );
  
            return getSetupForProp({ chalk, data, inquirer, model, setupData });
        });
    });

    const answers = await queue;

    console.log('');
    log(
        `The Next.js plugin requires some manual configuration. Please see ${chalk.bold('https://github.com/stackbithq/sourcebit-target-next#installation')} for instructions.`,
        'fail'
    );

    return answers;
  };
};

module.exports.bootstrap = async ({ debug, getPluginContext, log, options, refresh, setPluginContext }) => {

    const cacheFilePath = _.get(options, 'cacheFilePath', DEFAULT_FILE_CACHE_PATH);
    const wsPort = _.get(options, 'liveUpdateWsPort', DEFAULT_LIVE_UPDATE_PORT);
    const liveUpdate = _.get(options, 'liveUpdate', isDev);

    await fse.remove(cacheFilePath);

    if (liveUpdate) {
        startStaticPropsWatcher({ wsPort: wsPort });
    }

};

module.exports.transform = async ({ data, debug, getPluginContext, log, options }) => {

    const cacheFilePath = _.get(options, 'cacheFilePath', DEFAULT_FILE_CACHE_PATH);
    // allow configuring different ws port for client, useful if ws can be
    // proxied through same webserver that serves nest.js app
    const wsPort = _.get(options, 'liveUpdateWsClientPort', _.get(options, 'liveUpdateWsPort', DEFAULT_LIVE_UPDATE_PORT));
    const liveUpdate = _.get(options, 'liveUpdate', isDev);

    const reduceOptions = _.pick(options, ['commonProps', 'pages']);
    const transformedData = reduceAndTransformData(data.objects, reduceOptions);

    if (liveUpdate) {
        _.set(transformedData, 'props.liveUpdate', liveUpdate);
        _.set(transformedData, 'props.liveUpdateWsPort', wsPort);
        _.set(transformedData, 'props.liveUpdateEventName', LIVE_UPDATE_EVENT_NAME);
    }

    await fse.ensureFile(cacheFilePath);
    await fse.writeJson(cacheFilePath, transformedData);

    if (liveUpdate) {
        eventEmitter.emit(LIVE_UPDATE_EVENT_NAME);
    }

    return data;
};

class SourcebitDataClient {

    constructor() {
        // Every time getStaticPaths is called, the page re-imports all required
        // modules causing this singleton to be reconstructed loosing any in
        // memory cache.
        // https://github.com/zeit/next.js/issues/10933
        // console.log('SourcebitDataClient.constructor');
    }

    async getData() {
        console.log('SourcebitDataClient.getData');
        // For now, we are reading the changes from filesystem until re-import
        // of this module will be fixed: https://github.com/zeit/next.js/issues/10933
        // TODO: DEFAULT_FILE_CACHE_PATH won't work if default cache file path
        //   was changed, but also can't access the specified path because
        //   nextjs re-imports the whole module when this method is called
        const cacheFileExists = new Promise((resolve, reject) => {
            const retryDelay = 500;
            const maxNumOfRetries = 10;
            let numOfRetries = 0;
            const checkPathExists = async () => {
                const pathExists = await fse.pathExists(DEFAULT_FILE_CACHE_PATH);
                if (!pathExists && numOfRetries < maxNumOfRetries) {
                    numOfRetries += 1;
                    console.log(`SourcebitDataClient.getData, cache file '${DEFAULT_FILE_CACHE_PATH}' not found, waiting ${retryDelay}ms and retry #${numOfRetries}`);
                    setTimeout(checkPathExists, retryDelay);
                } else if (!pathExists) {
                    reject(new Error(`SourcebitDataClient.getData, cache file '${DEFAULT_FILE_CACHE_PATH}' was not found after ${numOfRetries} retries`));
                } else {
                    resolve();
                }
            };
            checkPathExists();
        });

        await cacheFileExists;

        return fse.readJson(DEFAULT_FILE_CACHE_PATH);
    }

    async getStaticPaths() {
        console.log('SourcebitDataClient.getStaticPaths');
        const data = await this.getData();
        return _.map(data.pages, (page) => page.path);
    }

    async getStaticPropsForPageAtPath(pagePath) {
        console.log('SourcebitDataClient.getStaticPropsForPath');
        const data = await this.getData();
        return this.getPropsFromCMSDataForPagePath(data, pagePath);
    }

    getPropsFromCMSDataForPagePath(data, pagePath) {
        const page = _.find(data.pages, {path: pagePath});
        return _.assign(
            page,
            data.props
        );
    }
}

const sourcebitDataClient = new SourcebitDataClient();

module.exports.sourcebitDataClient = sourcebitDataClient;
