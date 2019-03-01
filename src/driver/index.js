// Wrap/hide the complexity of whether to choose the web neo4j driver
// or the regular one.
import neo4j from 'neo4j-driver';
import _ from 'lodash';
import genericPool from 'generic-pool';
import sentry from '../sentry';

// As of Neo4j driver 1.7, no longer need to separately import
// the minified web driver.
// let driverObj;
// driverObj = neo4j.v1;

// Admittedly a bit nasty, this code detects whether what we're looking at is really a neo4j driver
// int object, which is a special object designed to overcome the range differences between Neo4j numbers
// and what JS can support.
const isNeo4jInt = o =>
    o && _.isObject(o) && !_.isNil(o.high) && !_.isNil(o.low) && _.keys(o).length === 2;

const handleNeo4jInt = val => {
    if (!isNeo4jInt(val)) { return val; }
    return neo4j.integer.inSafeRange(val) ? val.toNumber() : neo4j.integer.toString(val);
};

const getOrDefault = (rec, field, defaultValue=null) => {
    try {
        return rec.get(field);
    } catch (e) { return defaultValue; }
};

/**
 * Converts a Neo4j result set into an array of vanilla javascript objects.
 * Converts all numbers to either a number (if in range) or a string on a best effort
 * basis.
 * 
 * If a property is optional and it's missing, you will get null back.  If a property
 * is required and it's missing, you get an error thrown.
 * 
 * #operability this arose from a lot of boilerplate code I had been writing with the JS
 * driver.  Issues:  
 * - record.get() throws an error and doesn't let you specify a default if it's missing
 * - You have to do number handling on your own, every time.
 * 
 * @param {*} results the results object
 * @param {Object} schema consisting of two keys, required and optional.  Each of those
 * is an array of property names.
 * @returns {Array} of Objects
 */
const unpackResults = (results, schema) => results.records.map((record, index) => {
    const unpacked = { index };

    if (!schema || (!schema.required && !schema.optional)) {
        throw new Error('Unpack results was passed an invalid schema');
    }

    (schema.required || []).forEach(requiredField => {
        // Throws error if missing
        const value = record.get(requiredField);
        unpacked[requiredField] = isNeo4jInt(value) ? handleNeo4jInt(value) : value;
    });

    (schema.optional || []).forEach(optionalField => {
        const value = getOrDefault(record, optionalField);
        unpacked[optionalField] = isNeo4jInt(value) ? handleNeo4jInt(value) : value;
    });

    return unpacked;
});

/**
 * A session pool is just what it sounds like.  In bolt, there is overhead associated
 * with sessions (particularly network round trips) that can increase latency.
 * For this reason we aggressively reuse sessions as much as we can without trying to run
 * more than one transaction on a given session.
 * 
 * This pool object lets users lease/release a session.  In general the strategies are the
 * ones who are pulling these sessions.
 */
const pools = {};
const getSessionPool = (id, driver, poolSize=15) => {
    sentry.fine('POOL FOR', id);
    if (pools[id]) {
        sentry.fine('RECYCLE pool for ', id);
        return pools[id];
    }

    // How to create/destroy sessions.
    // See the generic-pool module for more details.
    const factory = {
        create: () => {
            const s = driver.session();
            return s;
        },
        destroy: session => {
            return session.close();
        },
        validate: session =>
            session.run('RETURN 1;', {})
                .then(results => true)
                .catch(err => false),
    };

    const sessionPoolOpts = { min: 1, max: poolSize };
    const sessionPool = genericPool.createPool(factory, sessionPoolOpts);
    sessionPool.on('factoryCreateError', err => console.log('SESSION POOL ERROR', err));
    sessionPool.on('factoryDestroyError', err => console.error('SESSION POOL DESTROY ERROR', err));
    sessionPool.start();

    pools[id] = sessionPool;
    return sessionPool;
};

neo4j.unpackResults = unpackResults;
neo4j.isNeo4jInt = isNeo4jInt;
neo4j.handleNeo4jInt = handleNeo4jInt;
neo4j.getSessionPool = getSessionPool;

export default neo4j;