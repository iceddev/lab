// Adapted from:
// Blanket https://github.com/alex-seville/blanket, copyright (c) 2013 Alex Seville, MIT licensed
// Falafel https://github.com/substack/node-falafel, copyright (c) James Halliday, MIT licensed


// Load modules

var Fs = require('fs');
var Path = require('path');
var Esprima = require('esprima');
var sourceMapSupport = require('source-map-support');
var Transform = require('./transform');


// Declare internals

var internals = {
    origLoader: require.extensions['.js'],
    patterns: [],
    sources: {},
    transforms: [ { ext: '.js', transform: null } ]
};

internals.transform = function (filename, content) {

    var ext = '';
    var transform = null;

    internals.transforms.forEach(function (element) {

        ext = element.ext;
        if (filename.indexOf(ext, filename.length - ext.length) !== -1) {
            transform = element.transform;
        }
    });

    var relativeFilename = filename.substr(process.cwd().length + 1);
    Transform.fileCache[relativeFilename] = (typeof transform === 'function') ? transform(content, relativeFilename) : content;
    return Transform.fileCache[relativeFilename];
};


internals.prime = function (extension) {

    require.extensions[extension] = function (localModule, filename) {

        for (var i = 0, il = internals.patterns.length; i < il; ++i) {
            if (internals.patterns[i].test(filename.replace(/\\/g, '/'))) {
                return localModule._compile(internals.instrument(filename), filename);
            }
        }

        return internals.origLoader(localModule, filename);
    };
};

exports.instrument = function (options) {

    internals.patterns.unshift(internals.pattern(options));

    if (Array.isArray(options.transform)) {
        options.transform.forEach(function (element) {

            if (element.ext === '.js') {
                internals.transforms[0].transform = element.transform;
            }
            else {
                internals.transforms.push(element);
            }
        });
    }

    internals.transforms.forEach(function (element) {

        internals.prime(element.ext);
    });
};


internals.pattern = function (options) {

    var base = internals.escape(options.coveragePath || '');
    var excludes = options.coverageExclude ? [].concat(options.coverageExclude).map(internals.escape).join('|') : '';
    var regex = '^' + base + (excludes ? (base[base.length - 1] === '/' ? '' : '\\/') + '(?!' + excludes + ')' : '');
    return new RegExp(regex);
};


internals.escape = function (string) {

    return string.replace(/\\/g, '/').replace(/[\^\$\.\*\+\-\?\=\!\:\|\\\/\(\)\[\]\{\}\,]/g, '\\$&');
};


internals.instrument = function (filename) {

    filename = filename.replace(/\\/g, '/');

    var file = Fs.readFileSync(filename, 'utf8');
    var content = file.replace(/^\#\!.*/, '');
    content = internals.transform(filename, content);

    var tracking = [];
    var statements = [];
    var chunks = content.split('');
    var ids = 0;
    var bypass = {};

    var annotate = function (node, parent) {

        // Decorate node

        node.parent = parent;

        node.source = function () {

            return chunks.slice(node.range[0], node.range[1]).join('');
        };

        node.set = function (s) {

            chunks[node.range[0]] = s;
            for (var i = node.range[0] + 1, il = node.range[1]; i < il; i++) {
                chunks[i] = '';
            }
        };

        // Coverage status

        if (bypass[node.range[0]]) {
            return;
        }

        // Recursively annotate the tree from the inner-most out

        Object.keys(node).forEach(function (name) {

            if (name === 'parent') {
                return;
            }

            var children = [].concat(node[name]);
            children.forEach(function (child) {

                if (child && typeof child.type === 'string') {              // Identify node types
                    annotate(child, node);
                }
            });
        });

        // Annotate source code

        var decoratedTypes = [
            'IfStatement',
            'WhileStatement',
            'DoWhileStatement',
            'ForStatement',
            'ForInStatement',
            'WithStatement'
        ];

        var consequent;
        var line;

        if (decoratedTypes.indexOf(node.type) !== -1) {
            if (node.alternate &&
                node.alternate.type !== 'BlockStatement') {

                node.alternate.set('{' + node.alternate.source() + '}');
            }

            consequent = node.consequent || node.body;
            if (consequent.type !== 'BlockStatement') {
                consequent.set('{' + consequent.source() + '}');
            }
        }

        var trackedTypes = [
            'ExpressionStatement',
            'BreakStatement',
            'ContinueStatement',
            'VariableDeclaration',
            'ReturnStatement',
            'ThrowStatement',
            'TryStatement',
            'FunctionDeclaration',
            'IfStatement',
            'WhileStatement',
            'DoWhileStatement',
            'ForStatement',
            'ForInStatement',
            'SwitchStatement',
            'WithStatement'
        ];

        if (trackedTypes.indexOf(node.type) !== -1 &&
            (node.type !== 'VariableDeclaration' || (node.parent.type !== 'ForStatement' && node.parent.type !== 'ForInStatement'))) {

            tracking.push(node.loc.start.line);
            node.set('__$$labCov._line(\'' + filename + '\',' + node.loc.start.line + ');' + node.source());
        }
        else if (node.type === 'ConditionalExpression') {
            line = node.loc.start.line;
            consequent = addStatement(line, node.consequent, false);
            var alternate = addStatement(line, node.alternate, false);

            node.set('(' + node.test.source() + '? __$$labCov._statement(\'' + filename + '\',' + consequent + ',' + line + ',' + node.consequent.source() + ') : __$$labCov._statement(\'' + filename + '\',' + alternate + ',' + line + ',' + node.alternate.source() + '))');
        }
        else if (node.type === 'LogicalExpression') {
            line = node.loc.start.line;
            var left = addStatement(line, node.left, true);
            var right = addStatement(line, node.right, node.parent.type === 'LogicalExpression');

            node.set('(__$$labCov._statement(\'' + filename + '\',' + left + ',' + line + ',' + node.left.source() + ')' + node.operator + '__$$labCov._statement(\'' + filename + '\',' + right + ',' + line + ',' + node.right.source() + '))');
        }
        else if (node.parent &&
            node.parent.test === node &&
            node.parent.type !== 'SwitchCase') {

            line = node.loc.start.line;
            var test = addStatement(line, node, true);

            node.set('__$$labCov._statement(\'' + filename + '\',' + test + ',' + line + ',' + node.source() + ')');
        }
    };

    var addStatement = function (line, node, bool) {

        var id = ++ids;
        statements.push({
            id: id,
            loc: node.loc,
            line: line,
            bool: bool && node.type !== 'ConditionalExpression' && node.type !== 'LogicalExpression'
        });
        return id;
    };

    // Parse tree

    var tree = Esprima.parse(content, { loc: true, comment: true, range: true });

    // Process comments

    var skipStart = 0;
    var segmentSkip = false;
    tree.comments.forEach(function (comment) {

        var directive = comment.value.match(/^\s*\$lab\:coverage\:(off|on)\$\s*$/);
        if (directive) {
            var skip = directive[1] !== 'on';
            if (skip !== segmentSkip) {
                segmentSkip = skip;
                if (skip) {
                    skipStart = comment.range[1];
                }
                else {
                    for (var s = skipStart; s < comment.range[0]; ++s) {
                        bypass[s] = true;
                    }
                }
            }
        }
    });

    // Begin code annotation

    annotate(tree);

    // Store original source

    internals.sources[filename] = file.replace(/(\r\n|\n|\r)/gm, '\n').split('\n');

    // Setup global report container
                                                        // $lab:coverage:off$
    if (typeof __$$labCov === 'undefined') {
        __$$labCov = {
            files: {},

            _line: function (filename, line) {

                __$$labCov.files[filename].lines[line]++;
            },

            _statement: function (filename, id, line, source) {

                var statement = __$$labCov.files[filename].statements[line][id];
                if (!statement.bool) {
                    statement.hit[!source] = true;
                }

                statement.hit[!!source] = true;
                return source;
            }
        };
    }                                                   // $lab:coverage:on$

    __$$labCov.files[filename] = {
        statements: {},
        lines: {}
    };

    var record = __$$labCov.files[filename];
    tracking.forEach(function (item) {

        record.lines[item] = 0;
    });

    statements.forEach(function (item) {

        record.statements[item.line] = record.statements[item.line] || {};
        record.statements[item.line][item.id] = { hit: {}, bool: item.bool, loc: item.loc };
    });

    return chunks.join('');
};


exports.analyze = function (options) {

    // Process coverage  (global.__$$labCov needed when labCov isn't defined)

    /* $lab:coverage:off$ */ var report = global.__$$labCov || { files: {} }; /* $lab:coverage:on$ */
    var pattern = internals.pattern(options);

    var cov = {
        sloc: 0,
        hits: 0,
        misses: 0,
        percent: 0,
        files: []
    };

    // Filter files

    var files = Object.keys(report.files);
    for (var i = 0, il = files.length; i < il; ++i) {
        var filename = files[i];
        if (pattern.test(filename)) {
            report.files[filename].source = internals.sources[filename] || [];
            var data = internals.file(filename, report.files[filename], options);

            cov.files.push(data);
            cov.hits += data.hits;
            cov.misses += data.misses;
            cov.sloc += data.sloc;
        }
    }

    // Sort files based on directory structure

    cov.files.sort(function (a, b) {

        var segmentsA = a.filename.split('/');
        var segmentsB = b.filename.split('/');

        var al = segmentsA.length;
        var bl = segmentsB.length;

        for (var i = 0; i < al && i < bl; ++i) {

            if (segmentsA[i] === segmentsB[i]) {
                continue;
            }

            var lastA = i + 1 === al;
            var lastB = i + 1 === bl;

            if (lastA !== lastB) {
                return lastA ? -1 : 1;
            }

            return segmentsA[i] < segmentsB[i] ? -1 : 1;
        }

        return segmentsA.length < segmentsB.length ? -1 : 1;
    });

    // Calculate coverage percentage

    if (cov.sloc > 0) {
        cov.percent = (cov.hits / cov.sloc) * 100;
    }

    return cov;
};

internals.addSourceMapsInformation = function (ret, num) {

    var position = {
        source: ret.filename,
        line: num,
        column: 0
    };
    var originalPosition = sourceMapSupport.mapSourcePosition(position);
    var source = ret.source[num];

    if (position !== originalPosition) {
        source.originalFilename = originalPosition.source.replace(Path.join(process.cwd(), '/').replace(/\\/g, '/'), '');
        source.originalLine = originalPosition.line;

        if (!ret.sourcemaps) {
            ret.sourcemaps = true;
        }
    }
    else {
        source.originalFilename = ret.filename;
        source.originalLine = num;
    }
};


internals.file = function (filename, data, options) {

    var ret = {
        filename: filename.replace(Path.join(process.cwd(), '/').replace(/\\/g, '/'), ''),
        percent: 0,
        hits: 0,
        misses: 0,
        sloc: 0,
        source: {}
    };

    // Process each line of code

    data.source.forEach(function (line, num) {

        num++;

        var isMiss = false;
        ret.source[num] = {
            source: line
        };

        if (options.sourcemaps) {
            internals.addSourceMapsInformation(ret, +num);
        }

        if (data.lines[num] === 0) {
            isMiss = true;
            ret.misses++;
            ret.sloc++;
        }
        else if (line) {
            ret.sloc++;

            if (data.statements[num]) {
                var mask = new Array(line.length);
                Object.keys(data.statements[num]).forEach(function (id) {

                    var statement = data.statements[num][id];
                    if (statement.hit.true &&
                        statement.hit.false) {

                        return;
                    }

                    if (statement.loc.start.line !== num) {
                        data.statements[statement.loc.start.line] = data.statements[statement.loc.start.line] || {};
                        data.statements[statement.loc.start.line][id] = statement;
                        return;
                    }

                    if (statement.loc.end.line !== num) {
                        data.statements[statement.loc.end.line] = data.statements[statement.loc.end.line] || {};
                        data.statements[statement.loc.end.line][id] = {
                            hit: statement.hit,
                            loc: {
                                start: {
                                    line: statement.loc.end.line,
                                    column: 0
                                },
                                end: {
                                    line: statement.loc.end.line,
                                    column: statement.loc.end.column
                                }
                            }
                        };

                        statement.loc.end.column = line.length;
                    }

                    isMiss = true;
                    var issue = statement.hit.true ? 'true' : (statement.hit.false ? 'false' : 'never');
                    for (var a = statement.loc.start.column; a < statement.loc.end.column; ++a) {
                        mask[a] = issue;
                    }
                });

                var chunks = [];

                var from = 0;
                for (var a = 1, al = mask.length; a < al; ++a) {
                    if (mask[a] !== mask[a - 1]) {
                        chunks.push({ source: line.slice(from, a), miss: mask[a - 1] });
                        from = a;
                    }
                }

                chunks.push({ source: line.slice(from), miss: mask[from] });

                if (isMiss) {
                    ret.source[num].chunks = chunks;
                    ret.misses++;
                }
                else {
                    ret.hits++;
                }
            }
            else {
                ret.hits++;
            }
        }

        ret.source[num].hits = data.lines[num];
        ret.source[num].miss = isMiss;
    });

    ret.percent = ret.hits / ret.sloc * 100;
    return ret;
};
