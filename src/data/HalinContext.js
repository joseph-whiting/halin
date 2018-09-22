import nd from '../neo4jDesktop/index';
import ClusterNode from '../data/ClusterNode';
import DataFeed from '../data/DataFeed';
import _ from 'lodash';
import Promise from 'bluebird';
import uuid from 'uuid';
import moment from 'moment';
import appPkg from '../package.json';
import ClusterManager from './cluster/ClusterManager';

const neo4j = require('neo4j-driver/lib/browser/neo4j-web.min.js').v1;

/**
 * HalinContext is a controller object that keeps track of state and permits diagnostic
 * reporting.
 * 
 * It creates its own drivers and does not use the Neo4j Desktop API provided drivers.
 * The main app will attach it to the window object as a global.
 */
export default class HalinContext {
    domain = 'halin';

    constructor() {
        this.project = null;
        this.graph = null;
        this.drivers = {};
        this.dataFeeds = {};
        this.driverOptions = {
            encrypted: true,
            connectionTimeout: 10000,
        };
        this.mgr = new ClusterManager(this);
    }

    /**
     * @returns {ClusterManager}
     */
    getClusterManager() {
        return this.mgr;
    }

    getDataFeed(feedOptions) {
        const df = new DataFeed(feedOptions);
        const feed = this.dataFeeds[df.name];
        if (feed) { return feed; }
        this.dataFeeds[df.name] = df;
        console.log('Halin starting new DataFeed: ', df.name.slice(0, 120) + '...');
        df.start();
        return df;
    }

    /**
     * Create a new driver for a given address.
     */
    driverFor(addr, username = _.get(this.base, 'username'), password = _.get(this.base, 'password')) {
        if (this.drivers[addr]) {
            return this.drivers[addr];
        }

        const driver = neo4j.driver(addr,
            neo4j.auth.basic(username, password),
            this.driverOptions);

        this.drivers[addr] = driver;
        return driver;
    }

    shutdown() {
        console.log('Shutting down halin context');
        Object.values(this.dataFeeds).map(df => df.stop);
        Object.values(this.drivers).map(driver => driver.close());
    }

    isCluster() {
        // Must have more than one node
        return this.clusterNodes && this.clusterNodes.length > 1;
    }

    checkForCluster(activeDb) {
        const session = this.base.driver.session();
        // console.log('activeDb', activeDb);
        return session.run('CALL dbms.cluster.overview()', {})
            .then(results => {
                this.clusterNodes = results.records.map(rec => new ClusterNode(rec))

                this.clusterNodes.forEach(node => {
                    console.log(node.getAddress());
                });
            })
            .catch(err => {
                const str = `${err}`;
                if (str.indexOf('no procedure') > -1) {
                    // Halin will look at single node databases
                    // running in desktop as clusters of size 1.
                    const rec = {
                        id: uuid.v4(),
                        addresses: nd.getAddressesForGraph(activeDb.graph),
                        role: 'SINGLE',
                        database: 'default',
                    };

                    // Psuedo object behaves like a cypher result record.
                    // Somewhere, a strong typing enthusiast is screaming. ;)
                    const get = key => rec[key];
                    rec.get = get;

                    this.clusterNodes = [new ClusterNode(rec)];

                    // Force driver creation and ping, this is basically
                    // just connecting to the whole cluster.
                    return this.clusterNodes.map(cn => this.ping(cn));
                } else {
                    throw err;
                }
            })
            .finally(() => session.close());
    }

    /**
     * Take a diagnostic package and return a cleaned up version of the same, removing
     * sensitive data that shouldn't go out.
     * This function intentionally modifies its argument.
     */
    cleanup(pkg) {
        const deepReplace = (keyToClean, newVal, object) => {
            let found = false;

            _.each(object, (val, key) => {
                if (key === keyToClean) {
                    console.log('found target key');
                    found = true;
                } else if(_.isArray(val)) {
                    object[key] = val.map(v => deepReplace(keyToClean, newVal, v));
                } else if (_.isObject(val)) {
                    
                    object[key] = deepReplace(keyToClean, newVal, val);
                }
            });

            if (found) {
                const copy = _.cloneDeep(object);
                copy[keyToClean] = newVal;
                return copy;
            }

            return object;
        };

        return deepReplace('password', '********', _.cloneDeep(pkg));
    }

    /**
     * Returns a promise that resolves to the HalinContext object completed,
     * or rejects.
     */
    initialize() {
        try {
            return nd.getFirstActive()
                .then(active => {
                    this.project = active.project;
                    this.graph = active.graph;

                    this.base = _.cloneDeep(active.graph.connection.configuration.protocols.bolt);

                    // Create a default driver to have around.
                    const uri = `bolt://${this.base.host}:${this.base.port}`;
                    this.base.driver = this.driverFor(uri);

                    console.log('HalinContext created', this);
                    return this.checkForCluster(active);
                })
                .then(() => this)
        } catch (e) {
            return Promise.reject(new Error('General Halin Context error', e));
        }
    }

    /**
     * Ping a cluster node with a trivial query, just to keep connections
     * alive and verify it's still listening.  This forces driver creation
     * for a node if it hasn't already happened.
     * @param {ClusterNode} the node to ping
     * @returns {Promise} that resolves to true or false for ping success
     */
    ping(clusterNode) {
        const addr = clusterNode.getBoltAddress();
        const driver = this.driverFor(addr);

        const session = driver.session();

        return session.run('RETURN true as value', {})
            .then(result => result.records[0].get('value'))
            .catch(err => {
                console.error('HalinContext: failed to ping',addr);
                return false;
            });
    }

    /**
     * @param clusterNode{ClusterNode} 
     * @return Promise{Object} of diagnostic information about that node.
     */
    _nodeDiagnostics(clusterNode) {
        const basics = {
            basics: {
                address: clusterNode.getBoltAddress(),
                protocols: clusterNode.protocols(),
                role: clusterNode.role,
                database: clusterNode.database,
                id: clusterNode.id,
            },
        };

        const session = this.driverFor(clusterNode.getBoltAddress()).session();

        // Query must return 'value'
        const noFailCheck = (domain, query, key) =>
            session.run(query, {})
                .then(results => results.records[0].get('value'))
                .catch(err => err)  // Convert errors into the value.
                .then(value => {
                    const obj = {};
                    obj[domain] = {};
                    obj[domain][key] = value;
                    return obj;
                });

        // Format all JMX data into records.
        // Put the whole thing into an object keyed on jmx.
        const genJMX = session.run("CALL dbms.queryJmx('*:*')", {})
            .then(results =>
                results.records.map(rec => ({
                    name: rec.get('name'),
                    attributes: rec.get('attributes'),
                })))
            .then(array => ({ JMX: array }))

        const users = session.run('CALL dbms.security.listUsers()', {})
            .then(results =>
                results.records.map(rec => ({
                    username: rec.get('username'),
                    flags: rec.get('flags'),
                    roles: rec.get('roles'),
                })))
            .then(allUsers => ({ users: allUsers }));

        const roles = session.run('CALL dbms.security.listRoles()', {})
            .then(results =>
                results.records.map(rec => ({
                    role: rec.get('role'),
                    users: rec.get('users'),
                })))
            .then(allRoles => ({ roles: allRoles }));

        // Format node config into records.
        const genConfig = session.run('CALL dbms.listConfig()', {})
            .then(results =>
                results.records.map(rec => ({
                    name: rec.get('name'), value: rec.get('value'),
                })))
            .then(allConfig => ({ configuration: allConfig }));

        const constraints = session.run('CALL db.constraints()', {})
            .then(results =>
                results.records.map((rec, idx) => ({ idx, description: rec.get('description') })))
            .then(allConstraints => ({ constraints: allConstraints }));

        const indexes = session.run('CALL db.indexes()', {})
            .then(results =>
                results.records.map((rec, idx) => ({
                    description: rec.get('description'),
                    label: rec.get('label'),
                    properties: rec.get('properties'),
                    state: rec.get('state'),
                    type: rec.get('type'),
                    provider: rec.get('provider'),
                })))
            .then(allIndexes => ({ indexes: allIndexes }));

        const otherPromises = [
            noFailCheck('apoc', 'RETURN apoc.version() as value', 'version'),
            noFailCheck('nodes', 'MATCH (n) RETURN count(n) as value', 'count'),
            noFailCheck('schema', 'call db.labels() yield label return collect(label) as value', 'labels'),
            noFailCheck('algo', 'RETURN algo.version() as value', 'version'),
        ];

        return Promise.all([
            users, roles, indexes, constraints, genJMX, genConfig, ...otherPromises])
            .then(arrayOfDiagnosticObjects =>
                _.merge(basics, ...arrayOfDiagnosticObjects))
            .finally(() => session.close());
    }

    /**
     * @return Promise{Object} of halin diagnostics.
     */
    _halinDiagnostics() {
        const halin = {
            halin: {
                drivers: Object.keys(this.drivers).map(uri => ({
                    domain: `${this.domain}-driver`,
                    node: uri,
                    key: 'encrypted',
                    value: _.get(this.drivers[uri]._config, 'encrypted'),
                })),
                diagnosticsGenerated: moment.utc().toISOString(),
                activeProject: this.cleanup(this.project),
                activeGraph: this.cleanup(this.graph),
                ...appPkg,
            }
        };

        return Promise.resolve(halin);
    }

    /**
     * @return Promise{Object} of Neo4j Desktop API diagnostics.
     */
    _neo4jDesktopDiagnostics() {
        const api = window.neo4jDesktopApi;

        if (!api) {
            return Promise.resolve({ neo4jDesktop: 'MISSING' });
        }

        return api.getContext()
            .then(context => ({
                neo4jDesktop: this.cleanup(_.cloneDeep(context)),
            }));
    }

    /**
     * Run all diagnostics available to halin
     * @return Promise{Object} a large, heavyweight diagnostic object suitable for
     * analysis or shipping to the user.
     */
    runDiagnostics() {
        const allNodeDiags = Promise.all(this.clusterNodes.map(clusterNode => this._nodeDiagnostics(clusterNode)))
            .then(nodeDiagnostics => ({ nodes: nodeDiagnostics }));

        const halinDiags = this._halinDiagnostics();

        const neo4jDesktopDiags = this._neo4jDesktopDiagnostics();

        // Each object resolves to a diagnostic object with 1 key, and sub properties.
        // All diagnostics are just a merge of those objects.
        return Promise.all([halinDiags, allNodeDiags, neo4jDesktopDiags])
            .then(arrayOfObjects => _.merge(...arrayOfObjects))
    }
}