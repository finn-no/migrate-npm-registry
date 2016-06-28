#!/usr/bin/env node

'use strict';

const Promise = require('bluebird');
const request = Promise.promisify(require('request'));
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const tar = require('tar-stream');
const exec = require('child_process').exec;

const USAGE = 'usage: migrate-npm-registry [pkg_name ...] source_registry target_registry';
const args = process.argv.slice(2);
const force = false;

if (args.length < 2 || args.indexOf('--help') !== -1) {
    console.log(USAGE);
    process.exit(1);
}

const targetRegistryURL = args.pop();
const sourceRegistryURL = args.pop();

if (args.length === 0) {
    console.log('Fetching list of all packages not implemented. Please specify package name(s).');
    process.exit(2);
}

const packages = args.slice(0);
packages.forEach(function packageDescriptorURL (pkgName) {
    Promise.all([
        request(pkgMetaDataURL(sourceRegistryURL, pkgName)),
        request(pkgMetaDataURL(targetRegistryURL, pkgName)),
    ])
    .then(metaDataResponsesToJSON)
    .spread(skipVersionsAlreadyOnTarget)
    .then(findTarballURLs)
    .then(downloadTarballs)
    .then(publishTarballsToTarget)
    .then(function (output) {
        if (output) {
            output.forEach(function (str) { console.log(str); });
        }
        console.log('DONE');
    })
    .catch(SyntaxError, function () {
        console.log('Syntax error. Please check your internet connection or registry URLs.');
        process.exit(1);
    })
    .catch(function (e) {
        if (e.message.indexOf('ENOTFOUND') !== -1) {
            console.log('Error. No network');
            process.exit(1);
        }
        throw e;
    });
});

function pkgMetaDataURL (registry, pkgName) {
    return `${registry.replace(/\/$/, '')}/${pkgName}`;
}

function metaDataResponsesToJSON (responses) {
    return responses.map(function (responseArray, i) {
        const response = responseArray[0];
        const body = responseArray[1];
        const isSourceResponse = (i === 0);
        let obj;

        if (isSourceResponse && response.statusCode !== 200) {
            throw new Error('Error fetching source metadata');
        }

        try {
            obj = JSON.parse(body);
        } catch (e) {
            if (isSourceResponse) { throw e; }
        }
        return obj;
    });
}

function skipVersionsAlreadyOnTarget (sourceMetaData, targetMetaData) {
    let versionsOnTarget;
    if (targetMetaData) {
        versionsOnTarget = Object.keys(targetMetaData.versions);
    }

    Object.keys(sourceMetaData.versions).forEach(function (version) {
        if (force) { return; }
        const alreadyOnTarget = (versionsOnTarget && versionsOnTarget.indexOf(version) !== -1);
        if (alreadyOnTarget || version !== '0.0.3') {
            console.log(`${version} already exists on target. Skipping.`);
            delete sourceMetaData.versions[version];
        }
    });

    return sourceMetaData;
}

function findTarballURLs (meta) {
    return Object.keys(meta.versions).map(function (v) {
        return meta.versions[v].dist.tarball;
    });
}

function downloadTarballs (urls) {
    return Promise.all(
        urls.map(function (url) {
            const tmpFile = `/tmp/${url.replace(/.*\/-\//, '')}`;
            return new Promise(downloadFile(url, tmpFile));
        })
    );
}

function downloadFile (url, fileName) {
    // var extract = tar.extract();
    const pack = tar.pack();

    return function (resolve, reject) {
        http.get(url, function (res) {
            const writeFileStream = fs.createWriteStream(fileName);
            res
            .pipe(zlib.createGunzip())
            .pipe(tar.extract())
            .on('error', reject)
            .on('entry', function (header, stream, next) {
                console.log(header.name);

                stream.pipe(pack.entry(header, next));
                /* if (entry.path === 'package.json') {

                }*/
            })
            .on('finish', pack.finalize)
            .pipe(writeFileStream)
            .on('error', reject)
            // .on('finish',)
            .on('close', resolve.bind(null, fileName));
        })
        .on('error', reject);
    };
}

function publishTarballsToTarget (tarballFiles) {
    return Promise.all(
        tarballFiles.map(function (file) {
            return new Promise(function (resolve, reject) {
                exec(`npm publish --registry ${targetRegistryURL} ${file}`, function (err, stdout, stderr) {
                    if (err) {
                        reject(err);
                    } else if (stderr) {
                        reject(stderr);
                    } else {
                        resolve(stdout);
                    }
                });
            });
        })
    );
}
