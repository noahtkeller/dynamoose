'use strict';

var Attribute = require('./Attribute');
var errors = require('./errors');
var VirtualType = require('./VirtualType');
//var util = require('util');

var debug = require('debug')('dynamoose:schema');



function Schema(obj, options) {
  debug('Creating Schema', obj);

  this.options = options || {};

  this.methods = {};
  this.statics = {};
  this.virtuals = {};
  this.tree = {};

  if(this.options.throughput) {
    var throughput = this.options.throughput;
    if(typeof throughput === 'number') {
      throughput = {read: throughput, write: throughput};
    }
    this.throughput = throughput;
  } else {
    this.throughput = {read: 1, write: 1};
  }

  if((!this.throughput.read || !this.throughput.write) &&
    this.throughput.read >= 1 && this.throughput.write >= 1) {
    throw new errors.SchemaError('Invalid throughput: '+ this.throughput);
  }

  /*
    * Added support for timestamps attribute
    */
  if (this.options.timestamps) {
    var createdAt = null;
    var updatedAt = null;

    if (this.options.timestamps === true) {
      createdAt = 'createdAt';
      updatedAt = 'updatedAt';
    } else if (typeof this.options.timestamps === 'object') {
      if (this.options.timestamps.createdAt && this.options.timestamps.updatedAt) {
        createdAt = this.options.timestamps.createdAt;
        updatedAt = this.options.timestamps.updatedAt;
      } else {
        throw new errors.SchemaError('Missing createdAt and updatedAt timestamps attribute. Maybe set timestamps: true?');
      }
    } else {
      throw new errors.SchemaError('Invalid syntax for timestamp: ' + name);
    }

    obj[createdAt] = obj[createdAt] || {};
    obj[createdAt].type = Date;
    obj[createdAt].default = Date.now;


    obj[updatedAt] = obj[updatedAt] || {};
    obj[updatedAt].type = Date;
    obj[updatedAt].default = Date.now;
    obj[updatedAt].set = function() { return Date.now(); };
    this.timestamps = { createdAt: createdAt, updatedAt: updatedAt };
  }


  /*
    * Added support for expires attribute
    */
  if (this.options.expires !== null && this.options.expires !== undefined ) {
    var expires = {
      attribute: 'expires'
    };

    if (typeof this.options.expires === 'number') {
      expires.ttl = this.options.expires;

    } else if (typeof this.options.expires === 'object') {
      if (typeof this.options.expires.ttl === 'number') {
        expires.ttl = this.options.expires.ttl;
      } else {
        throw new errors.SchemaError('Missing or invalided ttl for expires attribute.');
      }
      if(typeof this.options.expires.attribute === 'string') {
        expires.attribute = this.options.expires.attribute;
      }
    } else {
      throw new errors.SchemaError('Invalid syntax for expires: ' + name);
    }

    var defaultExpires = function () {
      return new Date(Date.now() + (expires.ttl * 1000));
    };

    obj[expires.attribute] = {
      type: Number,
      default: defaultExpires,
      set: function(v) {
        return Math.floor(v.getTime() / 1000);
      },
      get: function (v) {
        return new Date(v * 1000);
      }
    };
    this.expires = expires;
  }
  this.useDocumentTypes = !!this.options.useDocumentTypes;
  this.useNativeBooleans = !!this.options.useNativeBooleans;
  this.attributeFromDynamo = this.options.attributeFromDynamo;
  this.attributeToDynamo = this.options.attributeToDynamo;

  this.attributes = {};
  this.indexes = {local: {}, global: {}};

  for(var n in obj) {

    if(this.attributes[n]) {
      throw new errors.SchemaError('Duplicate attribute: ' + n);
    }

    debug('Adding Attribute to Schema (%s)', n, obj);
    this.attributes[n] = Attribute.create(this, n, obj[n]);
  }
}

/*Schema.prototype.attribute = function(name, obj) {
  debug('Adding Attribute to Schema (%s)', name, obj);

  this Attribute.create(name, obj);

};*/

Schema.prototype.toDynamo = function(model, options) {

  var dynamoObj = {};
  var name, attr;

  for(name in model) {
    if(!model.hasOwnProperty(name)){
      continue;
    }
    if (model[name] === undefined || model[name] === null || Number.isNaN(model[name])) {
      debug('toDynamo: skipping attribute: %s because its definition or value is null, undefined, or NaN', name);
      continue;
    }
    attr = this.attributes[name];
    if((!attr && this.options.saveUnknown === true) || (this.options.saveUnknown instanceof Array && this.options.saveUnknown.indexOf(name) >= 0)) {
      attr = Attribute.create(this, name, model[name]);
      this.attributes[name] = attr;
    }
  }

  for(name in this.attributes) {
    attr = this.attributes[name];

    attr.setDefault(model);
    var dynamoAttr;
    if (this.attributeToDynamo) {
      dynamoAttr = this.attributeToDynamo(name, model[name], model, attr.toDynamo.bind(attr), options);
    } else {
      dynamoAttr = attr.toDynamo(model[name], undefined, model, options);
    }
    if(dynamoAttr) {
      dynamoObj[attr.name] = dynamoAttr;
    }
  }

  debug('toDynamo: %s', dynamoObj );
  return dynamoObj;
};

Schema.prototype.parseDynamo = function(model, dynamoObj) {

  for(var name in dynamoObj) {
    var attr = this.attributes[name];

    if((!attr && this.options.saveUnknown === true) || (this.options.saveUnknown instanceof Array && this.options.saveUnknown.indexOf(name) >= 0)) {
      attr = Attribute.createUnknownAttrbuteFromDynamo(this, name, dynamoObj[name]);
      this.attributes[name] = attr;
    }

    if(attr) {
      var attrVal;
      if (this.attributeFromDynamo) {
        attrVal = this.attributeFromDynamo(name, dynamoObj[name], attr.parseDynamo.bind(attr), model);
      } else {
        attrVal = attr.parseDynamo(dynamoObj[name]);
      }
      if (attrVal !== undefined && attrVal !== null) {
        model[name] = attrVal;
      }
    } else {
      debug('parseDynamo: received an attribute name (%s) that is not defined in the schema', name);
    }
  }

  if (model.$__) {
    model.$__.originalItem = JSON.parse(JSON.stringify(model));
  }

  debug('parseDynamo: %s', model);

  return dynamoObj;

};

/**
 * Adds an instance method to documents constructed from Models compiled from this schema.
 *
 * ####Example
 *
 *     var schema = kittySchema = new Schema(..);
 *
 *     schema.method('meow', function () {
 *       console.log('meeeeeoooooooooooow');
 *     })
 *
 *     var Kitty = mongoose.model('Kitty', schema);
 *
 *     var fizz = new Kitty;
 *     fizz.meow(); // meeeeeooooooooooooow
 *
 * If a hash of name/fn pairs is passed as the only argument, each name/fn pair will be added as methods.
 *
 *     schema.method({
 *         purr: function () {}
 *       , scratch: function () {}
 *     });
 *
 *     // later
 *     fizz.purr();
 *     fizz.scratch();
 *
 * @param {String|Object} method name
 * @param {Function} [fn]
 * @api public
 */

Schema.prototype.method = function (name, fn) {
  if (typeof name !== 'string' ){
    for (var i in name){
      this.methods[i] = name[i];
    }
  } else {
    this.methods[name] = fn;
  }
  return this;
};

/**
 * Adds static "class" methods to Models compiled from this schema.
 *
 * ####Example
 *
 *     var schema = new Schema(..);
 *     schema.static('findByName', function (name, callback) {
 *       return this.find({ name: name }, callback);
 *     });
 *
 *     var Drink = mongoose.model('Drink', schema);
 *     Drink.findByName('sanpellegrino', function (err, drinks) {
 *       //
 *     });
 *
 * If a hash of name/fn pairs is passed as the only argument, each name/fn pair will be added as statics.
 *
 * @param {String} name
 * @param {Function} fn
 * @api public
 */

Schema.prototype.static = function(name, fn) {
  if (typeof name !== 'string' ){
    for (var i in name){
      this.statics[i] = name[i];
    }
  } else {
    this.statics[name] = fn;
  }
  return this;
};


/**
 * Creates a virtual type with the given name.
 *
 * @param {String} name
 * @param {Object} [options]
 * @return {VirtualType}
 */

Schema.prototype.virtual = function (name, options) {
  //var virtuals = this.virtuals;
  var parts = name.split('.');

  return this.virtuals[name] = parts.reduce(function (mem, part, i) {
    mem[part] || (mem[part] = (i === parts.length-1) ? new VirtualType(options, name) : {});
    return mem[part];
  }, this.tree);
};

/**
 * Returns the virtual type with the given `name`.
 *
 * @param {String} name
 * @return {VirtualType}
 */

Schema.prototype.virtualpath = function (name) {
  return this.virtuals[name];
};

/**
 * Loads an ES6 class into a schema. Maps [setters](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/set) + [getters](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/get), [static methods](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes/static),
 * and [instance methods](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes#Class_body_and_method_definitions)
 * to schema [virtuals](http://mongoosejs.com/docs/guide.html#virtuals),
 * [statics](http://mongoosejs.com/docs/guide.html#statics), and
 * [methods](http://mongoosejs.com/docs/guide.html#methods).
 *
 * ####Example:
 *
 * ```javascript
 * const md5 = require('md5');
 * const userSchema = new Schema({ email: String });
 * class UserClass {
 *   // `gravatarImage` becomes a virtual
 *   get gravatarImage() {
 *     const hash = md5(this.email.toLowerCase());
 *     return `https://www.gravatar.com/avatar/${hash}`;
 *   }
 *
 *   // `getProfileUrl()` becomes a document method
 *   getProfileUrl() {
 *     return `https://mysite.com/${this.email}`;
 *   }
 *
 *   // `findByEmail()` becomes a static
 *   static findByEmail(email) {
 *     return this.findOne({ email });
 *   }
 * }
 *
 * // `schema` will now have a `gravatarImage` virtual, a `getProfileUrl()` method,
 * // and a `findByEmail()` static
 * userSchema.loadClass(UserClass);
 * ```
 *
 * @param {Function} model
 * @param {Boolean} [virtualsOnly] if truthy, only pulls virtuals from the class, not methods or statics
 */
Schema.prototype.loadClass = function(model, virtualsOnly) {
  if (model === Object.prototype ||
    model === Function.prototype ||
    model.prototype.hasOwnProperty('$isDynamooseModelPrototype')) {
    return this;
  }

  this.loadClass(Object.getPrototypeOf(model));

  // Add static methods
  if (!virtualsOnly) {
    Object.getOwnPropertyNames(model).forEach(function inheritProperty(name) {
      if (name.match(/^(length|name|prototype)$/)) {
        return;
      }
      var method = Object.getOwnPropertyDescriptor(model, name);
      if (typeof method.value === 'function') {
        this.static(name, method.value);
      }
    }, this);
  }

  // Add methods and virtuals
  Object.getOwnPropertyNames(model.prototype).forEach(function(name) {
    if (name.match(/^(constructor)$/)) {
      return;
    }
    var method = Object.getOwnPropertyDescriptor(model.prototype, name);
    if (!virtualsOnly) {
      if (typeof method.value === 'function') {
        this.method(name, method.value);
      }
    }
    if (typeof method.get === 'function') {
      this.virtual(name).get(method.get);
    }
    if (typeof method.set === 'function') {
      this.virtual(name).set(method.set);
    }
  }, this);

  return this;
};

module.exports = Schema;
