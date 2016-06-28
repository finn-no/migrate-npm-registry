#!/usr/bin/env node

var bluebird = require('bluebird');
var request = bluebird.promisify(require('request'));
var http = require('http');
var fs = require('fs');
var zlib = require('zlib');
var tar = require('tar-stream');
var exec = require('child_process').exec;

var USAGE = "usage: migrate-npm-registry [pkg_name ...] source_registry target_registry";
var args = process.argv.slice(2);
var force = false;

if (args.length < 2 || args.indexOf('--help') !== -1) {
    console.log(USAGE);
    process.exit(1);
}

var targetRegistryURL = args.pop();
var sourceRegistryURL = args.pop();

if (args.length === 0) {
    console.log('Fetching list of all packages not implemented. Please specify package name(s).');
    process.exit(2);
}

var packages = args.slice(0);
packages.forEach(function packageDescriptorURL (pkgName) {

    bluebird.all([
        request(pkgMetaDataURL(sourceRegistryURL, pkgName)),
        request(pkgMetaDataURL(targetRegistryURL, pkgName))
    ])
    .then(metaDataResponsesToJSON)
    .spread(skipVersionsAlreadyOnTarget)
    .then(findTarballURLs)
    .then(downloadTarballs)
    .then(publishTarballsToTarget)
    .then(function (output) {
        if (output) {
            output.forEach(function (str) {console.log(str);});
        }
        console.log('DONE');
    })
    .catch(SyntaxError, function () {
        console.log('Syntax error. Please check your internet connection or registry URLs.');
        process.exit(1);
    })
    .catch(function (e) {
        if (e.message.indexOf('ENOTFOUND') !== -1) {
            console.log("Error. No network");
            process.exit(1);
        }
        throw e;
    });
});

function pkgMetaDataURL (registry, pkgName) {
    return registry.replace(/\/$/, '') + '/' + pkgName;
}

function metaDataResponsesToJSON (responses) {
    return responses.map(function (args, i) {
        var response = args[0];
        var body = args[1];
        var isSourceResponse = (i === 0);
        var obj;

        if (isSourceResponse && response.statusCode != 200) {
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
    var versionsOnTarget;
    if (targetMetaData) {
        versionsOnTarget = Object.keys(targetMetaData.versions);
    }

    Object.keys(sourceMetaData.versions).forEach(function (version) {
        if (force) { return; }
        var alreadyOnTarget = (versionsOnTarget && versionsOnTarget.indexOf(version) !== -1);
        if (alreadyOnTarget || version !== '0.0.3') {
            console.log(version + ' already exists on target. Skipping.');
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
    return bluebird.all(
        urls.map(function (url) {
            var tmpFile = '/tmp/' + url.replace(/.*\/-\//, '');
            return new bluebird(downloadFile(url, tmpFile));
        })
    );
}

function downloadFile (url, fileName) {
    //var extract = tar.extract();
    var pack = tar.pack();
    var path = require('path');

    return function (resolve, reject) {
        http.get(url, function (res) {
            var writeFileStream = fs.createWriteStream(fileName);
            res
            .pipe(zlib.createGunzip())
            .pipe(tar.extract())
            .on('error', reject)
            .on('entry', function (header, stream, next) {
                console.log(header.name);

                stream.pipe(pack.entry(header, next));
                /*if (entry.path === 'package.json') {

                }*/

            })
            .on('finish', pack.finalize)
            .pipe(writeFileStream)
            .on('error', reject)
            //.on('finish',)
            .on('close', resolve.bind(null, fileName));
        })
        .on('error', reject);
    };
}

function publishTarballsToTarget (tarballFiles) {
    return bluebird.all(
        tarballFiles.map(function (file) {
            return new bluebird(function (resolve, reject) {
                exec('npm publish --registry ' + targetRegistryURL + ' ' + file, function (err, stdout, stderr) {
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
