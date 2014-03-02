// Give a sort spec, which can be in any of these forms:
//   {"key1": 1, "key2": -1}
//   [["key1", "asc"], ["key2", "desc"]]
//   ["key1", ["key2", "desc"]]
//
// (.. with the first form being dependent on the key enumeration
// behavior of your javascript VM, which usually does what you mean in
// this case if the key names don't look like integers ..)
//
// return a function that takes two objects, and returns -1 if the
// first object comes first in order, 1 if the second object comes
// first, or 0 if neither object comes before the other.

Minimongo.Sorter = function (spec) {
  var self = this;

  self._sortSpecParts = [];

  if (spec instanceof Array) {
    for (var i = 0; i < spec.length; i++) {
      if (typeof spec[i] === "string") {
        self._sortSpecParts.push({
          path: spec[i],
          lookup: makeLookupFunction(spec[i]),
          ascending: true
        });
      } else {
        self._sortSpecParts.push({
          path: spec[i][0],
          lookup: makeLookupFunction(spec[i][0]),
          ascending: spec[i][1] !== "desc"
        });
      }
    }
  } else if (typeof spec === "object") {
    for (var key in spec) {
      self._sortSpecParts.push({
        path: key,
        lookup: makeLookupFunction(key),
        ascending: spec[key] >= 0
      });
    }
  } else {
    throw Error("Bad sort specification: " + JSON.stringify(spec));
  }

  // // XXX so instead what we need is a function "compare keys" which compares two
  // // keys, then an "extract key from doc" function which iterates through all
  // // the various branches trying to find the min key, and then the main compare
  // // function just gets to be extract keys and compare

  // // reduceValue takes in all the possible values for the sort key along various
  // // branches, and returns the min or max value (according to the bool
  // // findMin). Each value can itself be an array, and we look at its values
  // // too. (ie, we do a single level of flattening on branchValues, then find the
  // // min/max.)
  // //
  // // XXX This is actually wrong! In fact, the whole attempt to compile sort
  // //     functions independently of selectors is wrong. In MongoDB, if you have
  // //     documents {_id: 'x', a: [1, 10]} and {_id: 'y', a: [5, 15]}, then
  // //     C.find({}, {sort: {a: 1}}) puts x before y (1 comes before 5).  But
  // //     C.find({a: {$gt: 3}}, {sort: {a: 1}}) puts y before x (1 does not match
  // //     the selector, and 5 comes before 10).
  // //
  // //     The way this works is pretty subtle!  For example, if the documents are
  // //     instead {_id: 'x', a: [{x: 1}, {x: 10}]}) and
  // //             {_id: 'y', a: [{x: 5}, {x: 15}]}),
  // //     then C.find({'a.x': {$gt: 3}}, {sort: {'a.x': 1}}) and
  // //          C.find({a: {$elemMatch: {x: {$gt: 3}}}}, {sort: {'a.x': 1}})
  // //     both follow this rule (y before x).  ie, you do have to apply this
  // //     through $elemMatch.
  // var reduceValue = function (branchValues, findMin) {
  //   // Expand any leaf arrays that we find, and ignore those arrays themselves.
  //   branchValues = expandArraysInBranches(branchValues, true);
  //   var reduced = undefined;
  //   var first = true;
  //   // Iterate over all the values found in all the branches, and if a value is
  //   // an array itself, iterate over the values in the array separately.
  //   _.each(branchValues, function (branchValue) {
  //     if (first) {
  //       reduced = branchValue.value;
  //       first = false;
  //     } else {
  //       // Compare the value we found to the value we found so far, saving it
  //       // if it's less (for an ascending sort) or more (for a descending
  //       // sort).
  //       var cmp = LocalCollection._f._cmp(reduced, branchValue.value);
  //       if ((findMin && cmp > 0) || (!findMin && cmp < 0))
  //         reduced = branchValue.value;
  //     }
  //   });
  //   return reduced;
  // };

  // var comparators = _.map(sortSpecParts, function (specPart) {
  //   return function (a, b) {
  //     var aValue = reduceValue(specPart.lookup(a), specPart.ascending);
  //     var bValue = reduceValue(specPart.lookup(b), specPart.ascending);
  //     var compare = LocalCollection._f._cmp(aValue, bValue);
  //     return specPart.ascending ? compare : -compare;
  //   };
  // });

  self._keyComparator = composeComparators(
    _.map(self._sortSpecParts, function (spec, i) {
      return self._keyFieldComparator(i);
    }));
};

// In addition to these methods, sorter_project.js defines combineIntoProjection
// on the server only.
_.extend(Minimongo.Sorter.prototype, {
  getComparator: function (options) {
    var self = this;

    // If we have no distances, just use the comparator from the source
    // specification (which defaults to "everything is equal".
    if (!options || !options.distances) {
      return self._getBaseComparator();
    }

    var distances = options.distances;

    // Return a comparator which first tries the sort specification, and if that
    // says "it's equal", breaks ties using $near distances.
    return composeComparators([self._getBaseComparator(), function (a, b) {
      if (!distances.has(a._id))
        throw Error("Missing distance for " + a._id);
      if (!distances.has(b._id))
        throw Error("Missing distance for " + b._id);
      return distances.get(a._id) - distances.get(b._id);
    }]);
  },

  _getPaths: function () {
    var self = this;
    return _.pluck(self._sortSpecParts, 'path');
  },

  // Finds the minimum key from the doc, according to the sort specs.  (We say
  // "minimum" here but this is with respect to the sort spec, so "descending"
  // sort fields mean we're finding the max for that field.)
  //
  // Note that this is NOT "find the minimum value of the first field, the
  // minimum value of the second field, etc"... it's "choose the
  // lexicographically minimum value of the key vector, allowing only keys which
  // you can find along the same paths".  ie, for a doc {a: [{x: 0, y: 5}, {x:
  // 1, y: 3}]} with sort spec {'a.x': 1, 'a.y': 1}, the only keys are [0,5] and
  // [1,3], and the minimum key is [0,5]; notably, [0,3] is NOT a key.
  //
  // XXX we don't actually implement this yet because we aren't path-sensitive
  // XXX write direct unit tests for this stuff
  _getMinKeyFromDoc: function (doc) {
    var self = this;
    var minKey = null;

    self._generateKeysFromDoc(doc, function (key) {
      if (minKey === null) {
        minKey = key;
        return;
      }
      if (self._compareKeys(key, minKey) < 0) {
        minKey = key;
      }
    });

    if (minKey === null)
      throw Error("no keys?");
    return minKey;
  },

  // Iterates over each possible "key" from doc (ie, over each branch), calling
  // 'cb' with the key.
  // XXX match up paths
  _generateKeysFromDoc: function (doc, cb) {
    var self = this;

    if (self._sortSpecParts.length === 0)
      throw new Error("can't generate keys without a spec");

    var branchesForEachKey = _.map(self._sortSpecParts, function (spec) {
      // Expand any leaf arrays that we find, and ignore those arrays
      // themselves.  (We never sort based on an array itself.)
      var branches = expandArraysInBranches(spec.lookup(doc), true);
      // If there are no values for a key (eg, key goes to an empty array),
      // pretend we found one null value.
      if (!branches.length)
        branches = [{value: null}];
      return branches;
    });

    var indices = _.map(self._sortSpecParts, function () {
      return 0;
    });

    var done = false;
    while (!done) {
      var currentKey = _.map(indices, function (index, whichKey) {
        return branchesForEachKey[whichKey][index].value;
      });
      // Produce this key.
      cb(currentKey);

      for (var i = 0; i < indices.length; ++i) {
        if (indices[i] + 1 < branchesForEachKey[i].length) {
          ++indices[i];
          break;
        }
        if (i === indices.length - 1) {
          done = true;
          break;
        }
        indices[i] = 0;
      }
    }
  },

  // Takes in two keys: arrays whose lengths match the number of spec
  // parts. Returns negative, 0, or positive based on using the sort spec to
  // compare fields.
  _compareKeys: function (key1, key2) {
    var self = this;
    if (key1.length !== self._sortSpecParts.length ||
        key2.length !== self._sortSpecParts.length) {
      throw Error("Key has wrong length");
    }

    return self._keyComparator(key1, key2);
  },

  // Given an index 'i', returns a comparator that compares two key arrays based
  // on field 'i'.
  _keyFieldComparator: function (i) {
    var self = this;
    var invert = !self._sortSpecParts[i].ascending;
    return function (key1, key2) {
      var compare = LocalCollection._f._cmp(key1[i], key2[i]);
      if (invert)
        compare = -compare;
      return compare;
    };
  },

  // Returns a comparator that represents the sort specification (but not
  // including a possible geoquery distance tie-breaker).
  _getBaseComparator: function () {
    var self = this;

    // If we're only sorting on geoquery distance and no specs, just say
    // everything is equal.
    if (!self._sortSpecParts.length) {
      return function (doc1, doc2) {
        return 0;
      };
    }

    return function (doc1, doc2) {
      var key1 = self._getMinKeyFromDoc(doc1);
      var key2 = self._getMinKeyFromDoc(doc2);
      return self._compareKeys(key1, key2);
    };
  }
});

// Given an array of comparators
// (functions (a,b)->(negative or positive or zero)), returns a single
// comparator which uses each comparator in order and returns the first
// non-zero value.
var composeComparators = function (comparatorArray) {
  return function (a, b) {
    for (var i = 0; i < comparatorArray.length; ++i) {
      var compare = comparatorArray[i](a, b);
      if (compare !== 0)
        return compare;
    }
    return 0;
  };
};
