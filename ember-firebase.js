(function (Ember, Firebase, undefined) {

  var get = Ember.get,
      set = Ember.set,
      fmt = Ember.String.fmt,
      forEach = Ember.EnumerableUtils.forEach,
      RSVP = Ember.RSVP;

  /**
   * Returns a promise for the value at the given ref.
   */
  Firebase.get = function (ref) {
    var deferred = RSVP.defer();

    ref.once('value', function (snapshot) {
      deferred.resolve(getSnapshotValue(snapshot));
    }, deferred.reject);

    return deferred.promise;
  };

  /**
   * Sets the value of the given ref with an optional priority. Returns a
   * promise that resolves to the location reference when the sync is complete.
   */
  Firebase.set = function (ref, object, priority) {
    var value = getFirebaseValue(object);
    var deferred = RSVP.defer();

    function onComplete(error) {
      if (error) {
        deferred.reject(error);
      } else {
        deferred.resolve(ref);
      }
    }

    if (priority === undefined) {
      ref.set(value, onComplete);
    } else {
      ref.setWithPriority(value, priority, onComplete);
    }

    return deferred.promise;
  };

  /**
   * Pushes a value onto the given ref with an optional priority. Returns a
   * promise that resolves to the newly created location reference when the
   * sync is complete.
   */
  Firebase.push = function (ref, object, priority) {
    return Firebase.set(ref.push(), object, priority);
  };

  /**
   * Converts the given array into an object that can be stored in a Firebase
   * data structure and interpreted later by ember-firebase as a Firebase.Array.
   */
  Firebase.getArrayValue = function (array) {
    var value = { _isArray: true };

    forEach(array, function (object, index) {
      value[index] = getFirebaseValue(object);
    });

    return value;
  };

  if (Ember.EXTEND_PROTOTYPES) {
    Array.prototype.toFirebaseValue = function () {
      return Firebase.getArrayValue(this);
    };
  }

  /**
   * An Ember.Mixin for objects that are a proxy for a Firebase query
   * or location reference.
   */
  Firebase.Proxy = Ember.Mixin.create({

    /**
     * The Firebase location reference for this proxy. May also be a
     * Firebase query object.
     *
     * See https://www.firebase.com/docs/javascript/firebase/index.html
     * and https://www.firebase.com/docs/javascript/query/index.html
     */
    ref: null,

    /**
     * The writable Firebase location reference. This is only needed when
     * the original ref is actually a query.
     */
    writableRef: Ember.computed(function () {
      var ref = get(this, 'ref');

      if (ref && isFunction(ref.ref)) {
        return ref.ref(); // ref is a query
      }

      return ref;
    }).property('ref'),

    init: function () {
      this._super();
      this._setupRef();
    },

    willDestroy: function () {
      this._teardownRef();
    },

    _setupRef: Ember.observer(function () {
      var ref = get(this, 'ref');

      if (ref) {
        ref.on('value', this.valueDidChange, this);
        ref.on('child_added', this.childWasAdded, this);
        ref.on('child_changed', this.childWasChanged, this);
        ref.on('child_removed', this.childWasRemoved, this);
        ref.on('child_moved', this.childWasMoved, this);
      }
    }, 'ref'),

    _teardownRef: Ember.beforeObserver(function () {
      var ref = get(this, 'ref');

      if (ref) {
        ref.off('value', this.valueDidChange);
        ref.off('child_added', this.childWasAdded);
        ref.off('child_changed', this.childWasChanged);
        ref.off('child_removed', this.childWasRemoved);
        ref.off('child_moved', this.childWasMoved);
      }
    }, 'ref'),

    valueDidChange: Ember.K,
    childWasAdded: Ember.K,
    childWasChanged: Ember.K,
    childWasRemoved: Ember.K,
    childWasMoved: Ember.K

  });

  Firebase.Proxy.toString = function () {
    return 'Firebase.Proxy';
  };

  /**
   * An Ember.ObjectProxy for a Firebase data structure.
   *
   * See https://www.firebase.com/docs/data-structure.html
   */
  Firebase.Object = Ember.ObjectProxy.extend(Firebase.Proxy, {

    init: function () {
      this._resetContent();
      this._super();
    },

    _resetContent: Ember.beforeObserver(function () {
      set(this, 'content', {});
    }, 'ref'),

    /**
     * Ember.set uses this method to set properties on objects when the property
     * is not already present. We use it to set values on the underlying ref
     * instead, which propagates those changes to all listeners synchronously.
     */
    setUnknownProperty: function (property, object) {
      var ref = get(this, 'writableRef');
      Ember.assert(fmt('Cannot set property %@ on %@, ref is missing', [ property, this ]), ref);
      ref.child(property).set(getFirebaseValue(object));
      return get(this, property);
    },

    childWasAdded: function (snapshot) {
      return set(get(this, 'content'), snapshot.name(), getSnapshotValue(snapshot));
    },

    childWasChanged: function (snapshot) {
      return set(get(this, 'content'), snapshot.name(), getSnapshotValue(snapshot));
    },

    childWasRemoved: function (snapshot) {
      return set(get(this, 'content'), snapshot.name(), undefined);
    },

    toJSON: function () {
      var json = {};

      var content = get(this, 'content');
      for (var property in content) {
        json[property] = getFirebaseValue(get(content, property));
      }

      return json;
    },

    toString: function () {
      return fmt('<%@:%@>', [ get(this, 'constructor').toString(), get(this, 'writableRef').toString() ]);
    }

  });

  Firebase.Object.reopenClass({

    toString: function () {
      return 'Firebase.Object';
    }

  });

  /**
   * An Ember.ArrayProxy that respects the ordering of a Firebase data structure.
   * A Firebase.Array is able to be serialized and deserialized automatically. If
   * you have a plain array that you need to save you can use the toFirebaseValue
   * helper method on Array.prototype:
   *
   *   ref.set([ 1, 2, 3 ].toFirebaseValue());
   *   Firebase.get(ref).then(function (value) {
   *     // value is a Firebase.Array
   *   });
   *
   * You can also use Firebase.getArrayValue if you're not extending prototypes.
   *
   * IMPORTANT: There is currently no way to reliably alter the ordering of an array
   * in a Firebase data structure. Thus, when you add objects to a Firebase.Array using
   * Ember.MutableArray's methods (e.g. insertAt, unshiftObject, etc.) you will not
   * see that ordering in the array. Instead, all objects added to an array are
   * simply pushed onto it.
   *
   * If you need to enforce your own ordering you must use Firebase's priority feature.
   * You can either use the setWithPriority method directly on a child of this array's
   * location reference, or use pushObjectWithPriority.
   *
   * For more information on how Firebase stores ordered data and priorities, see
   * https://www.firebase.com/docs/managing-lists.html and
   * https://www.firebase.com/docs/ordered-data.html
   */
  Firebase.Array = Ember.ArrayProxy.extend(Firebase.Proxy, {

    init: function () {
      this._resetContent();
      this._super();
      this._setupWritableRef();
    },

    _resetContent: Ember.beforeObserver(function () {
      set(this, 'content', Ember.A([]));
      this._names = [];
    }, 'ref'),

    _setupWritableRef: Ember.observer(function () {
      var ref = get(this, 'writableRef');

      if (ref) {
        ref.child('_isArray').set(true);
      }
    }, 'writableRef'),

    /**
     * A convenience method for unconditionally adding an object to this array,
     * optionally with the given priority. Returns the newly generated Firebase
     * location reference.
     *
     * See https://www.firebase.com/docs/ordered-data.html
     */
    pushObjectWithPriority: function (object, priority) {
      var ref = get(this, 'writableRef');
      Ember.assert(fmt('Cannot push object %@ to %@, ref is missing', [ object, this ]), ref);

      var value = getFirebaseValue(object);
      var childRef = ref.push();

      if (priority === undefined) {
        childRef.set(getFirebaseValue(object));
      } else {
        childRef.setWithPriority(getFirebaseValue(object), priority);
      }

      return childRef;
    },

    /**
     * All Ember.MutableArray methods use this method to modify the array proxy's
     * content. We use it to make modifications on the underlying ref instead which
     * propagates those changes to all listeners synchronously.
     */
    replaceContent: function (index, amount, objects) {
      var ref = get(this, 'writableRef');
      Ember.assert(fmt('Cannot replace content of %@, ref is missing', [ this ]), ref);

      // Remove objects that are being replaced.
      forEach(this._names.slice(index, index + amount), function (childName) {
        ref.child(childName).remove();
      });

      // Add new objects.
      forEach(objects, function (object) {
        // TODO: Is there any way we can add the objects
        // at the given index instead of just using push?
        ref.push(getFirebaseValue(object));
      });
    },

    _indexAfter: function (name) {
      return name ? this._names.indexOf(name) + 1 : 0;
    },

    childWasAdded: function (snapshot, previousName) {
      if (snapshot.name() === '_isArray') return;
      var index = this._indexAfter(previousName);
      get(this, 'content').insertAt(index, getSnapshotValue(snapshot));
      this._names[index] = snapshot.name();
    },

    childWasChanged: function (snapshot, previousName) {
      if (snapshot.name() === '_isArray') return;
      var index = this._indexAfter(previousName);
      get(this, 'content').replace(index, 1, [ getSnapshotValue(snapshot) ]);
      this._names[index] = snapshot.name();
    },

    childWasRemoved: function (snapshot) {
      if (snapshot.name() === '_isArray') return;
      var index = this._names.indexOf(snapshot.name());
      if (index !== -1) {
        get(this, 'content').removeAt(index);
        this._names.splice(index, 1);
      }
    },

    childWasMoved: function (snapshot, previousName) {
      if (snapshot.name() === '_isArray') return;
      this.childWasRemoved(snapshot);
      this.childWasAdded(snapshot, previousName);
    },

    toJSON: function () {
      var content = get(this, 'content');
      var names = this._names;

      var json = { _isArray: true };
      for (var i = 0, len = names.length; i < len; ++i) {
        json[names[i]] = getFirebaseValue(content[i]);
      }

      return json;
    },

    toString: function () {
      return fmt('<%@:%@>', [ get(this, 'constructor').toString(), get(this, 'writableRef').toString() ]);
    }

  });

  Firebase.Array.reopenClass({

    toString: function () {
      return 'Firebase.Array';
    }

  });

  /**
   * Returns the value of the given Firebase snapshot as a JavaScript object,
   * automatically handling conversion to Firebase.Object and Firebase.Array
   * objects for locations that have children.
   */
  function getSnapshotValue(snapshot) {
    if (snapshot.hasChildren()) {
      if (snapshot.hasChild('_isArray')) {
        return Firebase.Array.create({ ref: snapshot.ref() });
      }

      return Firebase.Object.create({ ref: snapshot.ref() });
    }

    return snapshot.val();
  }

  /**
   * Returns a representation of the given object that is able to be saved
   * to a Firebase location.
   */
  function getFirebaseValue(object) {
    return object && isFunction(object.toJSON) ? object.toJSON() : object;
  }

  function isFunction(object) {
    return object && typeof object === 'function';
  }

}(Ember, Firebase));
