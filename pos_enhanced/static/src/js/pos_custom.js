(function ($) {
    $.widget("custom.combobox", {
        _create: function () {
            this.wrapper = $("<span>")
                .addClass("custom-combobox")
                .insertAfter(this.element);

            this.element.hide();
            this._createAutocomplete();
            this._createShowAllButton();
        },

        _createAutocomplete: function () {
            var selected = this.element.children(":selected"),
                value = selected.val() ? selected.text() : "";
            var self = this;

            this.input = $("<input>")
                .appendTo(this.wrapper)
                .val(value)
                .attr("title", "")
                .addClass("custom-combobox-input ui-widget ui-widget-content ui-state-default ui-corner-left")
                .autocomplete({
                    delay: 0,
                    minLength: 0,
                    source: $.proxy(this, "_source")
                })
                .tooltip({
                    tooltipClass: "ui-state-highlight"
                });

            this._on(this.input, {
                autocompleteselect: function (event, ui) {
                    ui.item.option.selected = true;
                    this._trigger("select", event, {
                        item: ui.item.option
                    });
                    self.element.trigger('change');

                },

                autocompletechange: "_removeIfInvalid"
            });
        },

        _createShowAllButton: function () {
            var input = this.input,
                wasOpen = false;

            $("<a>")
                .attr("tabIndex", -1)
                .attr("title", "Show All Items")
                .tooltip()
                .appendTo(this.wrapper)
                .button({
                    icons: {
                        primary: "fa fa-trash"
                    },
                    text: false
                })
                .removeClass("ui-corner-all")
                .addClass("custom-combobox-toggle ui-corner-right")
                .mousedown(function () {
                    wasOpen = input.autocomplete("widget").is(":visible");
                })
                .click(function () {
                    input.focus();

                    // Close if already visible
                    if (wasOpen) {
                        return;
                    }

                    // Pass empty string as value to search for, displaying all results
                    input.autocomplete("search", "");
                });
        },

        _source: function (request, response) {
            var matcher = new RegExp($.ui.autocomplete.escapeRegex(request.term), "i");
            response(this.element.children("option").map(function () {
                var text = $(this).text();
                if (this.value && ( !request.term || matcher.test(text) ))
                    return {
                        label: text,
                        value: text,
                        option: this
                    };
            }));
        },

        _removeIfInvalid: function (event, ui) {

            // Selected an item, nothing to do
            if (ui.item) {
                return;
            }

            // Search for a match (case-insensitive)
            var value = this.input.val(),
                valueLowerCase = value.toLowerCase(),
                valid = false;
            this.element.children("option").each(function () {
                if ($(this).text().toLowerCase() === valueLowerCase) {
                    this.selected = valid = true;
                    return false;
                }
            });

            // Found a match, nothing to do
            if (valid) {
                return;
            }

            // Remove invalid value
            this.input
                .val("")
                .attr("title", value + " didn't match any item")
                .tooltip("open");
            this.element.val("");
            this._delay(function () {
                this.input.tooltip("close").attr("title", "");
            }, 2500);
            this.input.autocomplete("instance").term = "";
        },

        _destroy: function () {
            this.wrapper.remove();
            this.element.show();
        }
    });
})(jQuery);

function openerp_pos_cashier(instance, module) { //module is instance.point_of_sale
    var module = instance.point_of_sale;
    var QWeb = instance.web.qweb;
    _t = instance.web._t;

    globalCashier = null;
    module.PosModel = Backbone.Model.extend({
        initialize: function (session, attributes) {
            Backbone.Model.prototype.initialize.call(this, attributes);
            var self = this;
            this.session = session;
            this.flush_mutex = new $.Mutex();                   // used to make sure the orders are sent to the server once at time
            this.pos_widget = attributes.pos_widget;

            this.proxy = new module.ProxyDevice(this);              // used to communicate to the hardware devices via a local proxy
            this.barcode_reader = new module.BarcodeReader({'pos': this, proxy: this.proxy, patterns: {}});  // used to read barcodes
            this.proxy_queue = new module.JobQueue();           // used to prevent parallels communications to the proxy
            this.db = new module.PosDB();                       // a local database used to search trough products and categories & store pending orders
            this.debug = jQuery.deparam(jQuery.param.querystring()).debug !== undefined;    //debug mode 

            // Business data; loaded from the server at launch
            this.accounting_precision = 2; //TODO
            this.company_logo = null;
            this.company_logo_base64 = '';
            this.currency = null;
            this.shop = null;
            this.company = null;
            this.user = null;
            this.users = [];
            this.partners = [];
            this.cashier = null;
            this.cashregisters = [];
            this.bankstatements = [];
            this.taxes = [];
            this.pos_session = null;
            this.config = null;
            this.units = [];
            this.units_by_id = {};
            this.pricelist = null;
            this.order_sequence = 1;
            window.posmodel = this;

            // these dynamic attributes can be watched for change by other models or widgets
            this.set({
                'synch': {state: 'connected', pending: 0},
                'orders': new module.OrderCollection(),
                'selectedOrder': null,
            });

            this.bind('change:synch', function (pos, synch) {
                clearTimeout(self.synch_timeout);
                self.synch_timeout = setTimeout(function () {
                    if (synch.state !== 'disconnected' && synch.pending > 0) {
                        self.set('synch', {state: 'disconnected', pending: synch.pending});
                    }
                }, 3000);
            });

            this.get('orders').bind('remove', function (order, _unused_, options) {
                self.on_removed_order(order, options.index, options.reason);
            });

            // We fetch the backend data on the server asynchronously. this is done only when the pos user interface is launched,
            // Any change on this data made on the server is thus not reflected on the point of sale until it is relaunched. 
            // when all the data has loaded, we compute some stuff, and declare the Pos ready to be used. 
            this.ready = this.load_server_data()
                .then(function () {
                    if (self.config.use_proxy) {
                        return self.connect_to_proxy();
                    }
                });

        },

        // releases ressources holds by the model at the end of life of the posmodel
        destroy: function () {
            // FIXME, should wait for flushing, return a deferred to indicate successfull destruction
            // this.flush();
            this.proxy.close();
            this.barcode_reader.disconnect();
            this.barcode_reader.disconnect_from_proxy();
        },
        connect_to_proxy: function () {
            var self = this;
            var done = new $.Deferred();
            this.barcode_reader.disconnect_from_proxy();
            this.pos_widget.loading_message(_t('Connecting to the PosBox'), 0);
            this.pos_widget.loading_skip(function () {
                self.proxy.stop_searching();
            });
            this.proxy.autoconnect({
                force_ip: self.config.proxy_ip || undefined,
                progress: function (prog) {
                    self.pos_widget.loading_progress(prog);
                },
            }).then(function () {
                if (self.config.iface_scan_via_proxy) {
                    self.barcode_reader.connect_to_proxy();
                }
            }).always(function () {
                done.resolve();
            });
            return done;
        },

        // helper function to load data from the server. Obsolete use the models loader below.
        fetch: function (model, fields, domain, ctx) {
            this._load_progress = (this._load_progress || 0) + 0.05;
            this.pos_widget.loading_message(_t('Loading') + ' ' + model, this._load_progress);
            return new instance.web.Model(model).query(fields).filter(domain).context(ctx).all()
        },

        // Server side model loaders. This is the list of the models that need to be loaded from
        // the server. The models are loaded one by one by this list's order. The 'loaded' callback
        // is used to store the data in the appropriate place once it has been loaded. This callback
        // can return a deferred that will pause the loading of the next module. 
        // a shared temporary dictionary is available for loaders to communicate private variables
        // used during loading such as object ids, etc. 
        models: [
            {
                model: 'res.users',
                fields: ['name', 'company_id'],
                ids: function (self) {
                    return [self.session.uid];
                },
                loaded: function (self, users) {
                    self.user = users[0];
                },
            }, {
                model: 'res.company',
                fields: ['currency_id', 'email', 'website', 'company_registry', 'vat', 'name', 'phone', 'partner_id', 'country_id', 'tax_calculation_rounding_method'],
                ids: function (self) {
                    return [self.user.company_id[0]]
                },
                loaded: function (self, companies) {
                    self.company = companies[0];
                },
            }, {
                model: 'decimal.precision',
                fields: ['name', 'digits'],
                loaded: function (self, dps) {
                    self.dp = {};
                    for (var i = 0; i < dps.length; i++) {
                        self.dp[dps[i].name] = dps[i].digits;
                    }
                },
            }, {
                model: 'product.uom',
                fields: [],
                domain: null,
                context: function (self) {
                    return {active_test: false};
                },
                loaded: function (self, units) {
                    self.units = units;
                    var units_by_id = {};
                    for (var i = 0, len = units.length; i < len; i++) {
                        units_by_id[units[i].id] = units[i];
                        units[i].groupable = ( units[i].category_id[0] === 1 );
                        units[i].is_unit = ( units[i].id === 1 );
                    }
                    self.units_by_id = units_by_id;
                }
            }, {
                model: 'res.users',
                fields: ['name', 'ean13'],
                domain: null,
                loaded: function (self, users) {
                    self.users = users;
                },
            }, {
                model: 'res.partner',
                fields: ['name', 'street', 'city', 'state_id', 'country_id', 'vat', 'phone', 'zip', 'mobile', 'email', 'ean13', 'write_date'],
                domain: [['customer', '=', true]],
                loaded: function (self, partners) {
                    self.partners = partners;
                    self.db.add_partners(partners);
                },
            }, {
                model: 'res.country',
                fields: ['name'],
                loaded: function (self, countries) {
                    self.countries = countries;
                    self.company.country = null;
                    for (var i = 0; i < countries.length; i++) {
                        if (countries[i].id === self.company.country_id[0]) {
                            self.company.country = countries[i];
                        }
                    }
                },
            }, {
                model: 'account.tax',
                fields: ['name', 'amount', 'price_include', 'include_base_amount', 'type', 'child_ids', 'child_depend', 'include_base_amount'],
                domain: null,
                loaded: function (self, taxes) {
                    self.taxes = taxes;
                    self.taxes_by_id = {};
                    _.each(taxes, function (tax) {
                        self.taxes_by_id[tax.id] = tax;
                    });
                    _.each(self.taxes_by_id, function (tax) {
                        tax.child_taxes = {};
                        _.each(tax.child_ids, function (child_tax_id) {
                            tax.child_taxes[child_tax_id] = self.taxes_by_id[child_tax_id];
                        });
                    });
                },
            }, {
                model: 'pos.session',
                fields: ['id', 'journal_ids', 'name', 'user_id', 'config_id', 'start_at', 'stop_at', 'sequence_number', 'login_number'],
                domain: function (self) {
                    return [['state', '=', 'opened'], ['user_id', '=', self.session.uid]];
                },
                loaded: function (self, pos_sessions) {
                    self.pos_session = pos_sessions[0];

                    var orders = self.db.get_orders();
                    for (var i = 0; i < orders.length; i++) {
                        self.pos_session.sequence_number = Math.max(self.pos_session.sequence_number, orders[i].data.sequence_number + 1);
                    }
                    debugger;
                },
            }, {
                model: 'pos.config',
                fields: [],
                domain: function (self) {
                    return [['id', '=', self.pos_session.config_id[0]]];
                },
                loaded: function (self, configs) {
                    self.config = configs[0];
                    self.config.use_proxy = self.config.iface_payment_terminal ||
                        self.config.iface_electronic_scale ||
                        self.config.iface_print_via_proxy ||
                        self.config.iface_scan_via_proxy ||
                        self.config.iface_cashdrawer;

                    self.barcode_reader.add_barcode_patterns({
                        'product': self.config.barcode_product,
                        'cashier': self.config.barcode_cashier,
                        'client': self.config.barcode_customer,
                        'weight': self.config.barcode_weight,
                        'discount': self.config.barcode_discount,
                        'price': self.config.barcode_price,
                    });

                    if (self.config.company_id[0] !== self.user.company_id[0]) {
                        throw new Error(_t("Error: The Point of Sale User must belong to the same company as the Point of Sale. You are probably trying to load the point of sale as an administrator in a multi-company setup, with the administrator account set to the wrong company."));
                    }
                },
            }, {
                model: 'stock.location',
                fields: [],
                ids: function (self) {
                    return [self.config.stock_location_id[0]];
                },
                loaded: function (self, locations) {
                    self.shop = locations[0];
                },
            }, {
                model: 'product.pricelist',
                fields: ['currency_id'],
                ids: function (self) {
                    return [self.config.pricelist_id[0]];
                },
                loaded: function (self, pricelists) {
                    self.pricelist = pricelists[0];
                },
            }, {
                model: 'res.currency',
                fields: ['name', 'symbol', 'position', 'rounding', 'accuracy'],
                ids: function (self) {
                    return [self.pricelist.currency_id[0]];
                },
                loaded: function (self, currencies) {
                    self.currency = currencies[0];
                    if (self.currency.rounding > 0) {
                        self.currency.decimals = Math.ceil(Math.log(1.0 / self.currency.rounding) / Math.log(10));
                    } else {
                        self.currency.decimals = 0;
                    }

                },
            }, {
                model: 'product.packaging',
                fields: ['ean', 'product_tmpl_id'],
                domain: null,
                loaded: function (self, packagings) {
                    self.db.add_packagings(packagings);
                },
            }, {
                model: 'pos.category',
                fields: ['id', 'name', 'parent_id', 'child_id', 'image'],
                domain: null,
                loaded: function (self, categories) {
                    self.db.add_categories(categories);
                },
            }, {
                model: 'product.product',
                fields: ['display_name', 'list_price', 'price', 'pos_categ_id', 'taxes_id', 'ean13', 'default_code',
                    'to_weight', 'uom_id', 'uos_id', 'uos_coeff', 'mes_type', 'description_sale', 'description',
                    'product_tmpl_id'],
                domain: [['sale_ok', '=', true], ['available_in_pos', '=', true]],
                context: function (self) {
                    return {pricelist: self.pricelist.id, display_default_code: false};
                },
                loaded: function (self, products) {
                    self.db.add_products(products);
                },
            }, {
                model: 'account.bank.statement',
                fields: ['account_id', 'currency', 'journal_id', 'state', 'name', 'user_id', 'pos_session_id'],
                domain: function (self) {
                    return [['state', '=', 'open'], ['pos_session_id', '=', self.pos_session.id]];
                },
                loaded: function (self, bankstatements, tmp) {
                    self.bankstatements = bankstatements;

                    tmp.journals = [];
                    _.each(bankstatements, function (statement) {
                        tmp.journals.push(statement.journal_id[0]);
                    });
                },
            }, {
                model: 'account.journal',
                fields: [],
                domain: function (self, tmp) {
                    return [['id', 'in', tmp.journals]];
                },
                loaded: function (self, journals) {
                    self.journals = journals;

                    // associate the bank statements with their journals.
                    var bankstatements = self.bankstatements;
                    for (var i = 0, ilen = bankstatements.length; i < ilen; i++) {
                        for (var j = 0, jlen = journals.length; j < jlen; j++) {
                            if (bankstatements[i].journal_id[0] === journals[j].id) {
                                bankstatements[i].journal = journals[j];
                            }
                        }
                    }
                    self.cashregisters = bankstatements;
                },
            }, {
                label: 'fonts',
                loaded: function (self) {
                    var fonts_loaded = new $.Deferred();

                    // Waiting for fonts to be loaded to prevent receipt printing
                    // from printing empty receipt while loading Inconsolata
                    // ( The font used for the receipt )
                    waitForWebfonts(['Lato', 'Inconsolata'], function () {
                        fonts_loaded.resolve();
                    });

                    // The JS used to detect font loading is not 100% robust, so
                    // do not wait more than 5sec
                    setTimeout(function () {
                        fonts_loaded.resolve();
                    }, 5000);

                    return fonts_loaded;
                },
            }, {
                label: 'pictures',
                loaded: function (self) {
                    self.company_logo = new Image();
                    var logo_loaded = new $.Deferred();
                    self.company_logo.onload = function () {
                        var img = self.company_logo;
                        var ratio = 1;
                        var targetwidth = 300;
                        var maxheight = 150;
                        if (img.width !== targetwidth) {
                            ratio = targetwidth / img.width;
                        }
                        if (img.height * ratio > maxheight) {
                            ratio = maxheight / img.height;
                        }
                        var width = Math.floor(img.width * ratio);
                        var height = Math.floor(img.height * ratio);
                        var c = document.createElement('canvas');
                        c.width = width;
                        c.height = height
                        var ctx = c.getContext('2d');
                        ctx.drawImage(self.company_logo, 0, 0, width, height);

                        self.company_logo_base64 = c.toDataURL();
                        logo_loaded.resolve();
                    };
                    self.company_logo.onerror = function () {
                        logo_loaded.reject();
                    };
                    self.company_logo.crossOrigin = "anonymous";
                    self.company_logo.src = '/web/binary/company_logo' + '?_' + Math.random();

                    return logo_loaded;
                },
            },
        ],

        // loads all the needed data on the sever. returns a deferred indicating when all the data has loaded. 
        load_server_data: function () {
            var self = this;
            var loaded = new $.Deferred();
            var progress = 0;
            var progress_step = 1.0 / self.models.length;
            var tmp = {}; // this is used to share a temporary state between models loaders

            function load_model(index) {
                if (index >= self.models.length) {
                    loaded.resolve();
                } else {
                    var model = self.models[index];
                    self.pos_widget.loading_message(_t('Loading') + ' ' + (model.label || model.model || ''), progress);
                    var fields = typeof model.fields === 'function' ? model.fields(self, tmp) : model.fields;
                    var domain = typeof model.domain === 'function' ? model.domain(self, tmp) : model.domain;
                    var context = typeof model.context === 'function' ? model.context(self, tmp) : model.context;
                    var ids = typeof model.ids === 'function' ? model.ids(self, tmp) : model.ids;
                    progress += progress_step;


                    if (model.model) {
                        if (model.ids) {
                            var records = new instance.web.Model(model.model).call('read', [ids, fields], context);
                        } else {
                            var records = new instance.web.Model(model.model).query(fields).filter(domain).context(context).all()
                        }
                        records.then(function (result) {
                            try {    // catching exceptions in model.loaded(...)
                                $.when(model.loaded(self, result, tmp))
                                    .then(function () {
                                            load_model(index + 1);
                                        },
                                        function (err) {
                                            loaded.reject(err);
                                        });
                            } catch (err) {
                                loaded.reject(err);
                            }
                        }, function (err) {
                            loaded.reject(err);
                        });
                    } else if (model.loaded) {
                        try {    // catching exceptions in model.loaded(...)
                            $.when(model.loaded(self, tmp))
                                .then(function () {
                                        load_model(index + 1);
                                    },
                                    function (err) {
                                        loaded.reject(err);
                                    });
                        } catch (err) {
                            loaded.reject(err);
                        }
                    } else {
                        load_model(index + 1);
                    }
                }
            }

            try {
                load_model(0);
            } catch (err) {
                loaded.reject(err);
            }

            return loaded;
        },

        // reload the list of partner, returns as a deferred that resolves if there were
        // updated partners, and fails if not
        load_new_partners: function () {
            var self = this;
            var def = new $.Deferred();
            var fields = _.find(this.models, function (model) {
                return model.model === 'res.partner';
            }).fields;
            new instance.web.Model('res.partner')
                .query(fields)
                .filter([['write_date', '>', this.db.get_partner_write_date()]])
                .all({'timeout': 3000, 'shadow': true})
                .then(function (partners) {
                    if (self.db.add_partners(partners)) {   // check if the partners we got were real updates
                        def.resolve();
                    } else {
                        def.reject();
                    }
                }, function (err, event) {
                    event.preventDefault();
                    def.reject();
                });
            return def;
        },

        // this is called when an order is removed from the order collection. It ensures that there is always an existing
        // order and a valid selected order
        on_removed_order: function (removed_order, index, reason) {
            if ((reason === 'abandon' || removed_order.temporary) && this.get('orders').size() > 0) {
                // when we intentionally remove an unfinished order, and there is another existing one
                this.set({'selectedOrder': this.get('orders').at(index) || this.get('orders').last()});
            } else {
                // when the order was automatically removed after completion, 
                // or when we intentionally delete the only concurrent order
                this.add_new_order();
            }
        },

        //creates a new empty order and sets it as the current order
        add_new_order: function () {
            var order = new module.Order({pos: this});
            //order.on('orderready' , function(){
            this.get('orders').add(order);
            this.set('selectedOrder', order);
            //})
        },

        get_order: function () {
            return this.get('selectedOrder');
        },

        //removes the current order
        delete_current_order: function () {
            this.get('selectedOrder').destroy({'reason': 'abandon'});
        },

        // saves the order locally and try to send it to the backend. 
        // it returns a deferred that succeeds after having tried to send the order and all the other pending orders.
        push_order: function (order) {
            var self = this;

            if (order) {
                this.proxy.log('push_order', order.export_as_JSON());
                this.db.add_order(order.export_as_JSON());
            }

            var pushed = new $.Deferred();

            this.flush_mutex.exec(function () {
                var flushed = self._flush_orders(self.db.get_orders());

                flushed.always(function (ids) {
                    pushed.resolve();
                });
            });
            return pushed;
        },

        // saves the order locally and try to send it to the backend and make an invoice
        // returns a deferred that succeeds when the order has been posted and successfully generated
        // an invoice. This method can fail in various ways:
        // error-no-client: the order must have an associated partner_id. You can retry to make an invoice once
        //     this error is solved
        // error-transfer: there was a connection error during the transfer. You can retry to make the invoice once
        //     the network connection is up 

        push_and_invoice_order: function (order) {
            var self = this;
            var invoiced = new $.Deferred();

            if (!order.get_client()) {
                invoiced.reject('error-no-client');
                return invoiced;
            }

            var order_id = this.db.add_order(order.export_as_JSON());

            this.flush_mutex.exec(function () {
                var done = new $.Deferred(); // holds the mutex

                // send the order to the server
                // we have a 30 seconds timeout on this push.
                // FIXME: if the server takes more than 30 seconds to accept the order,
                // the client will believe it wasn't successfully sent, and very bad
                // things will happen as a duplicate will be sent next time
                // so we must make sure the server detects and ignores duplicated orders

                var transfer = self._flush_orders([self.db.get_order(order_id)], {timeout: 30000, to_invoice: true});

                transfer.fail(function () {
                    invoiced.reject('error-transfer');
                    done.reject();
                });

                // on success, get the order id generated by the server
                transfer.pipe(function (order_server_id) {

                    // generate the pdf and download it
                    self.pos_widget.do_action('point_of_sale.pos_invoice_report', {
                        additional_context: {
                            active_ids: order_server_id,
                        }
                    });

                    invoiced.resolve();
                    done.resolve();
                });

                return done;

            });

            return invoiced;
        },

        // wrapper around the _save_to_server that updates the synch status widget
        _flush_orders: function (orders, options) {
            var self = this;

            this.set('synch', {state: 'connecting', pending: orders.length});

            return self._save_to_server(orders, options).done(function (server_ids) {
                var pending = self.db.get_orders().length;

                self.set('synch', {
                    state: pending ? 'connecting' : 'connected',
                    pending: pending
                });

                return server_ids;
            });
        },

        // send an array of orders to the server
        // available options:
        // - timeout: timeout for the rpc call in ms
        // returns a deferred that resolves with the list of
        // server generated ids for the sent orders
        _save_to_server: function (orders, options) {
            if (!orders || !orders.length) {
                var result = $.Deferred();
                result.resolve([]);
                return result;
            }

            options = options || {};

            var self = this;
            var timeout = typeof options.timeout === 'number' ? options.timeout : 7500 * orders.length;

            // we try to send the order. shadow prevents a spinner if it takes too long. (unless we are sending an invoice,
            // then we want to notify the user that we are waiting on something )
            var posOrderModel = new instance.web.Model('pos.order');
            return posOrderModel.call('create_from_ui',
                [_.map(orders, function (order) {
                    order.to_invoice = options.to_invoice || false;
                    return order;
                })],
                undefined,
                {
                    shadow: !options.to_invoice,
                    timeout: timeout
                }
            ).then(function (server_ids) {
                _.each(orders, function (order) {
                    self.db.remove_order(order.id);
                });
                return server_ids;
            }).fail(function (error, event) {
                if (error.code === 200) {    // Business Logic Error, not a connection problem
                    self.pos_widget.screen_selector.show_popup('error-traceback', {
                        message: error.data.message,
                        comment: error.data.debug
                    });
                }
                // prevent an error popup creation by the rpc failure
                // we want the failure to be silent as we send the orders in the background
                event.preventDefault();
                console.error('Failed to send orders:', orders);
            });
        },

        scan_product: function (parsed_code) {
            var self = this;
            var selectedOrder = this.get('selectedOrder');
            if (parsed_code.encoding === 'ean13') {
                var product = this.db.get_product_by_ean13(parsed_code.base_code);
            } else if (parsed_code.encoding === 'reference') {
                var product = this.db.get_product_by_reference(parsed_code.code);
            }

            if (!product) {
                return false;
            }

            if (parsed_code.type === 'price') {
                selectedOrder.addProduct(product, {price: parsed_code.value});
            } else if (parsed_code.type === 'weight') {
                selectedOrder.addProduct(product, {quantity: parsed_code.value, merge: false});
            } else if (parsed_code.type === 'discount') {
                selectedOrder.addProduct(product, {discount: parsed_code.value, merge: false});
            } else {
                selectedOrder.addProduct(product);
            }
            return true;
        },
    });

    module.CashierWidget = module.PosWidget.include({
        template: 'PosWidget',

        init: function (parent, options) {
            this._super(parent);
            var self = this;
        },

        // recuperation de l'ID du POS
        get_cur_pos_config_id: function () {
            var self = this;
            var pos_session = self.pos.pos_session;

            if (pos_session) {
                var config_id = pos_session.config_id;
                return config_id[0];
            }
            return '';
        },

        fetch: function (model, fields, domain, ctx) {
            return new instance.web.Model(model).query(fields).filter(domain).context(ctx).all()
        },

        cashier_change: function (id) {
            globalCashier = id;
            var name = $('select#cashier-select>option[value="' + id + '"]').text();
            $('#pay-screen-cashier-name').html(name);

            if (name != '') {
                $('.gotopay-button').removeAttr('disabled');
            } else {
                $('.gotopay-button').attr('disabled', 'disabled');
            }
        },

        get_cashiers: function (config_id) {
            var self = this;
            var cashier_list = [];
            var loaded = self.fetch('res.users', ['id', 'display_name'], [['active', '=', 'true']])
                .then(function (cashiers) {
                    for (var i = 0, len = cashiers.length; i < len; i++) {
                        cashier_list.push({
                            name: cashiers[i].display_name,
                            id: cashiers[i].id
                        });
                    }

                    if (cashier_list.length > 0) {

                        for (var i = 0, len = cashier_list.length; i < len; i++) {
                            var content = self.$('#cashier-select').html();
                            var new_option = '<option value="' + cashier_list[i].id + '">' + cashier_list[i].name + '</option>\n';
                            self.$('#cashier-select').html(content + new_option);
                        }

                        self.$('#AlertNoCashier').css('display', 'none');
                        self.$('#cashier-select').combobox();
                        self.$('#cashier-select').selectedIndex = 0;
                        globalCashier = cashier_list[0].id;
                        self.cashier_change(globalCashier);

                    } else {

                        // if there are no cashier
                        self.$('#AlertNoCashier').css('display', 'inline-block');
                        self.$('#cashier-select').css('display', 'none');
                        self.$('.gotopay-button').attr('disabled', 'disabled');
                    }
                });
        },

        renderElement: function () {
            var self = this;
            this._super();

            self.$('#cashier-select').change(function () {
                var id = this.value;
                self.cashier_change(id);
            });
        },


        build_widgets: function () {
            var self = this;

            // --------  Screens ---------

            this.product_screen = new module.ProductScreenWidget(this, {});
            this.product_screen.appendTo(this.$('.screens'));

            this.receipt_screen = new module.ReceiptScreenWidget(this, {});
            this.receipt_screen.appendTo(this.$('.screens'));

            this.payment_screen = new module.PaymentScreenWidget(this, {});
            this.payment_screen.appendTo(this.$('.screens'));

            this.clientlist_screen = new module.ClientListScreenWidget(this, {});
            this.clientlist_screen.appendTo(this.$('.screens'));

            this.scale_screen = new module.ScaleScreenWidget(this, {});
            this.scale_screen.appendTo(this.$('.screens'));


            // --------  Popups ---------

            this.error_popup = new module.ErrorPopupWidget(this, {});
            this.error_popup.appendTo(this.$el);

            this.error_barcode_popup = new module.ErrorBarcodePopupWidget(this, {});
            this.error_barcode_popup.appendTo(this.$el);

            this.error_traceback_popup = new module.ErrorTracebackPopupWidget(this, {});
            this.error_traceback_popup.appendTo(this.$el);

            this.confirm_popup = new module.ConfirmPopupWidget(this, {});
            this.confirm_popup.appendTo(this.$el);

            this.unsent_orders_popup = new module.UnsentOrdersPopupWidget(this, {});
            this.unsent_orders_popup.appendTo(this.$el);

            // --------  Misc ---------

            this.close_button = new module.HeaderButtonWidget(this, {
                label: _t('Close'),
                action: function () {
                    var self = this;
                    if (!this.confirmed) {
                        this.$el.addClass('confirm');
                        this.$el.text(_t('Confirm'));
                        this.confirmed = setTimeout(function () {
                            self.$el.removeClass('confirm');
                            self.$el.text(_t('Close'));
                            self.confirmed = false;
                        }, 2000);
                    } else {
                        clearTimeout(this.confirmed);
                        this.pos_widget.close();
                    }
                },
            });
            this.close_button.appendTo(this.$('.pos-rightheader'));

            this.notification = new module.SynchNotificationWidget(this, {});
            this.notification.appendTo(this.$('.pos-rightheader'));

            if (this.pos.config.use_proxy) {
                this.proxy_status = new module.ProxyStatusWidget(this, {});
                this.proxy_status.appendTo(this.$('.pos-rightheader'));
            }

            this.username = new module.UsernameWidget(this, {});
            this.username.replace(this.$('.placeholder-UsernameWidget'));

            this.action_bar = new module.ActionBarWidget(this);
            this.action_bar.replace(this.$(".placeholder-RightActionBar"));

            this.paypad = new module.PaypadWidget(this, {});
            this.paypad.replace(this.$('.placeholder-PaypadWidget'));

            this.numpad = new module.NumpadWidget(this);
            this.numpad.replace(this.$('.placeholder-NumpadWidget'));

            this.order_widget = new module.OrderWidget(this, {});
            this.order_widget.replace(this.$('.placeholder-OrderWidget'));

            this.onscreen_keyboard = new module.OnscreenKeyboardWidget(this, {
                'keyboard_model': 'simple'
            });
            this.onscreen_keyboard.replace(this.$('.placeholder-OnscreenKeyboardWidget'));

            // --------  Screen Selector ---------

            this.screen_selector = new module.ScreenSelector({
                pos: this.pos,
                screen_set: {
                    'products': this.product_screen,
                    'payment': this.payment_screen,
                    'scale': this.scale_screen,
                    'receipt': this.receipt_screen,
                    'clientlist': this.clientlist_screen,
                },
                popup_set: {
                    'error': this.error_popup,
                    'error-barcode': this.error_barcode_popup,
                    'error-traceback': this.error_traceback_popup,
                    'confirm': this.confirm_popup,
                    'unsent-orders': this.unsent_orders_popup,
                },
                default_screen: 'products',
                default_mode: 'cashier',
            });

            if (this.pos.debug) {
                this.debug_widget = new module.DebugWidget(this);
                this.debug_widget.appendTo(this.$('.pos-content'));
            }

            this.disable_rubberbanding();

        },
    });

    module.CashierPayScreenWidget = module.PaymentScreenWidget.include({
        template: 'PaymentScreenWidget',

        show: function () {
            this._super();
            var self = this;
            this.$('#pay-screen-cashier-name').html(globalCashier);
            this.$('#ticket-screen-cashier-name').html(globalCashier);
            this.pos.get('selectedOrder').set_cashier_name(globalCashier);

            this.paypad = new module.PaypadWidget(this, {});
            this.paypad.replace($('#placeholder-PaypadWidget'));
        },

    });

    module.CashierReceiptScreenWidget = module.ReceiptScreenWidget.extend({

        refresh: function () {
            this._super();
            $('.pos-receipt-container', this.$el).html(QWeb.render('PosTicket', {widget: this}));

            if (globalCashier != '') {
                this.$('#ticket-screen-cashier-name').html(globalCashier);
            }
        },

    });
    module.Order = Backbone.Model.extend({
        initialize: function (attributes) {
            Backbone.Model.prototype.initialize.apply(this, arguments);
            this.pos = attributes.pos;
            this.sequence_number = this.pos.pos_session.sequence_number++;
            this.uid = this.generateUniqueId();
            this.data_darsh = this.get_the_date_sasa();
            this.set({
                creationDate: new Date(),
                orderLines: new module.OrderlineCollection(),
                paymentLines: new module.PaymentlineCollection(),
                name: _t("Order ") + this.uid,
                sasa_op: this.data_darsh,
                client: null,
            });

            this.selected_orderline = undefined;
            this.selected_paymentline = undefined;
            this.screen_data = {};  // see ScreenSelector
            this.receipt_type = 'receipt';  // 'receipt' || 'invoice'
            this.temporary = attributes.temporary || false;
            var curOrder = this;
            this.get_the_other_main()
                .then(function (result) {
                    curOrder.pro = result; //got it right
                    curOrder.set({
                        sales_person: null,
                        sales_person_name: null,
                        new_id: curOrder.pro
                    });
                    curOrder.trigger('orderready', curOrder);
                });


            return this;
        },
        get_the_other_main: function () {
            var dfd = new jQuery.Deferred();
            var sasa = this.pos.pos_session.id
            new instance.web.Model("pos.order").call('get_the_product', [sasa]).done(
                function (results) {
                    var result = results.toString().split(',');
                    var stringsl = result[1];
                    var thenum = stringsl.replace(/^\D+/g, '');
                    var sasa = parseInt(thenum, 10) + 1
                    var zika = ('000' + sasa).slice(-4)
                    var the_str = result[1].slice(0, -4).toString();
                    var new_seq_sasa = the_str + zika
                    dfd.resolve(new_seq_sasa);
                });
            return dfd
        },
        get_the_date_sasa: function () {
            var date = new Date();
            var yyyy = date.getFullYear().toString();
            var mm = (date.getMonth() + 1).toString();
            var dd = date.getDate().toString();
            var mmChars = mm.split('');
            var ddChars = dd.split('');
            return  (ddChars[1]?dd:"0"+ddChars[0])+'/'+(mmChars[1]?mm:"0"+mmChars[0])+'/'+yyyy;
        },
        is_empty: function () {
            return (this.get('orderLines').models.length === 0);
        },
        generateUniqueId: function () {
            function zero_pad(num, size) {
                var s = "" + num;
                while (s.length < size) {
                    s = "0" + s;
                }
                return s;
            }

            return zero_pad(this.pos.pos_session.id, 5) + '-' +
                zero_pad(this.pos.pos_session.login_number, 3) + '-' +
                zero_pad(this.sequence_number, 4);
        },
        addOrderline: function (line) {
            if (line.order) {
                order.removeOrderline(line);
            }
            line.order = this;
            this.get('orderLines').add(line);
            this.selectLine(this.getLastOrderline());
        },
        addProduct: function (product, options) {
            options = options || {};
            var attr = JSON.parse(JSON.stringify(product));
            attr.pos = this.pos;
            attr.order = this;
            var line = new module.Orderline({}, {pos: this.pos, order: this, product: product});

            if (options.quantity !== undefined) {
                line.set_quantity(options.quantity);
            }
            if (options.price !== undefined) {
                line.set_unit_price(options.price);
            }
            if (options.discount !== undefined) {
                line.set_discount(options.discount);
            }

            var last_orderline = this.getLastOrderline();
            if (last_orderline && last_orderline.can_be_merged_with(line) && options.merge !== false) {
                last_orderline.merge(line);
            } else {
                this.get('orderLines').add(line);
            }
            this.selectLine(this.getLastOrderline());
        },
        removeOrderline: function (line) {
            this.get('orderLines').remove(line);
            this.selectLine(this.getLastOrderline());
        },
        getOrderline: function (id) {
            var orderlines = this.get('orderLines').models;
            for (var i = 0; i < orderlines.length; i++) {
                if (orderlines[i].id === id) {
                    return orderlines[i];
                }
            }
            return null;
        },
        getLastOrderline: function () {
            return this.get('orderLines').at(this.get('orderLines').length - 1);
        },
        addPaymentline: function (cashregister) {
            var paymentLines = this.get('paymentLines');
            var newPaymentline = new module.Paymentline({}, {cashregister: cashregister, pos: this.pos});
            if (cashregister.journal.type !== 'cash') {
                newPaymentline.set_amount(Math.max(this.getDueLeft(), 0));
            }
            paymentLines.add(newPaymentline);
            this.selectPaymentline(newPaymentline);

        },
        removePaymentline: function (line) {
            if (this.selected_paymentline === line) {
                this.selectPaymentline(undefined);
            }
            this.get('paymentLines').remove(line);
        },
        getName: function () {
            return this.get('name');
        },
        getSubtotal: function () {
            return (this.get('orderLines')).reduce((function (sum, orderLine) {
                return sum + orderLine.get_display_price();
            }), 0);
        },
        getTotalTaxIncluded: function () {
            return (this.get('orderLines')).reduce((function (sum, orderLine) {
                return sum + orderLine.get_price_with_tax();
            }), 0);
        },
        getDiscountTotal: function () {
            return (this.get('orderLines')).reduce((function (sum, orderLine) {
                return sum + (orderLine.get_unit_price() * (orderLine.get_discount() / 100) * orderLine.get_quantity());
            }), 0);
        },
        getTotalTaxExcluded: function () {
            return (this.get('orderLines')).reduce((function (sum, orderLine) {
                return sum + orderLine.get_price_without_tax();
            }), 0);
        },
        getTax: function () {
            return (this.get('orderLines')).reduce((function (sum, orderLine) {
                return sum + orderLine.get_tax();
            }), 0);
        },
        getTaxDetails: function () {
            var details = {};
            var fulldetails = [];

            this.get('orderLines').each(function (line) {
                var ldetails = line.get_tax_details();
                for (var id in ldetails) {
                    if (ldetails.hasOwnProperty(id)) {
                        details[id] = (details[id] || 0) + ldetails[id];
                    }
                }
            });

            for (var id in details) {
                if (details.hasOwnProperty(id)) {
                    fulldetails.push({
                        amount: details[id],
                        tax: this.pos.taxes_by_id[id],
                        name: this.pos.taxes_by_id[id].name
                    });
                }
            }

            return fulldetails;
        },
        getPaidTotal: function () {
            return (this.get('paymentLines')).reduce((function (sum, paymentLine) {
                return sum + paymentLine.get_amount();
            }), 0);
        },
        getChange: function () {
            return this.getPaidTotal() - this.getTotalTaxIncluded();
        },
        getDueLeft: function () {
            return this.getTotalTaxIncluded() - this.getPaidTotal();
        },
        // sets the type of receipt 'receipt'(default) or 'invoice'
        set_receipt_type: function (type) {
            this.receipt_type = type;
        },
        get_receipt_type: function () {
            return this.receipt_type;
        },
        set_cashier_name: function (id) {
            this.set('sales_person', id);
            this.set('sales_person_name', $('#cashier-select>option[value=' + id + ']').text());
        },
        // the client related to the current order.
        set_client: function (client) {
            this.set('client', client);
        },
        get_client: function () {
            return this.get('client');
        },
        get_client_name: function () {
            var client = this.get('client');
            return client ? client.name : "";
        },
        // the order also stores the screen status, as the PoS supports
        // different active screens per order. This method is used to
        // store the screen status.
        set_screen_data: function (key, value) {
            if (arguments.length === 2) {
                this.screen_data[key] = value;
            } else if (arguments.length === 1) {
                for (key in arguments[0]) {
                    this.screen_data[key] = arguments[0][key];
                }
            }
        },
        //see set_screen_data
        get_screen_data: function (key) {
            return this.screen_data[key];
        },
        // exports a JSON for receipt printing
        export_for_printing: function () {
            var orderlines = [];
            this.get('orderLines').each(function (orderline) {
                orderlines.push(orderline.export_for_printing());
            });

            var paymentlines = [];
            this.get('paymentLines').each(function (paymentline) {
                paymentlines.push(paymentline.export_for_printing());
            });
            var client = this.get('client');
            var cashier = this.pos.cashier || this.pos.user;
            var company = this.pos.company;
            var shop = this.pos.shop;
            var date = new Date();

            return {
                orderlines: orderlines,
                paymentlines: paymentlines,
                subtotal: this.getSubtotal(),
                total_with_tax: this.getTotalTaxIncluded(),
                total_without_tax: this.getTotalTaxExcluded(),
                total_tax: this.getTax(),
                total_paid: this.getPaidTotal(),
                total_discount: this.getDiscountTotal(),
                tax_details: this.getTaxDetails(),
                change: this.getChange(),
                name: this.getName(),
                client: client ? client.name : null,
                invoice_id: null,   //TODO
                cashier: cashier ? cashier.name : null,
                header: this.pos.config.receipt_header || '',
                footer: this.pos.config.receipt_footer || '',
                precision: {
                    price: 2,
                    money: 2,
                    quantity: 3,
                },
                date: {
                    year: date.getFullYear(),
                    month: date.getMonth(),
                    date: date.getDate(),       // day of the month 
                    day: date.getDay(),         // day of the week 
                    hour: date.getHours(),
                    minute: date.getMinutes(),
                    isostring: date.toISOString(),
                    localestring: date.toLocaleString(),
                },
                company: {
                    email: company.email,
                    website: company.website,
                    company_registry: company.company_registry,
                    contact_address: company.partner_id[1],
                    vat: company.vat,
                    name: company.name,
                    phone: company.phone,
                    logo: this.pos.company_logo_base64,
                },
                shop: {
                    name: shop.name,
                },
                currency: this.pos.currency,
            };
        },
        export_as_JSON: function () {
            var orderLines, paymentLines;
            orderLines = [];
            (this.get('orderLines')).each(_.bind(function (item) {
                return orderLines.push([0, 0, item.export_as_JSON()]);
            }, this));
            paymentLines = [];
            (this.get('paymentLines')).each(_.bind(function (item) {
                return paymentLines.push([0, 0, item.export_as_JSON()]);
            }, this));
            return {
                name: this.getName(),
                amount_paid: this.getPaidTotal(),
                amount_total: this.getTotalTaxIncluded(),
                amount_tax: this.getTax(),
                amount_return: this.getChange(),
                lines: orderLines,
                statement_ids: paymentLines,
                pos_session_id: this.pos.pos_session.id,
                partner_id: this.get_client() ? this.get_client().id : false,
                user_id: this.pos.cashier ? this.pos.cashier.id : this.pos.user.id,
                uid: this.uid,
                sequence_number: this.sequence_number,
                sales_person: this.pos.get('selectedOrder').get('sales_person'),
            };
        },
        getSelectedLine: function () {
            return this.selected_orderline;
        },
        selectLine: function (line) {
            if (line) {
                if (line !== this.selected_orderline) {
                    if (this.selected_orderline) {
                        this.selected_orderline.set_selected(false);
                    }
                    this.selected_orderline = line;
                    this.selected_orderline.set_selected(true);
                }
            } else {
                this.selected_orderline = undefined;
            }
        },
        deselectLine: function () {
            if (this.selected_orderline) {
                this.selected_orderline.set_selected(false);
                this.selected_orderline = undefined;
            }
        },
        selectPaymentline: function (line) {
            if (line !== this.selected_paymentline) {
                if (this.selected_paymentline) {
                    this.selected_paymentline.set_selected(false);
                }
                this.selected_paymentline = line;
                if (this.selected_paymentline) {
                    this.selected_paymentline.set_selected(true);
                }
                this.trigger('change:selected_paymentline', this.selected_paymentline);
            }
        },
    });

    module.OrderCollection = Backbone.Collection.extend({
        model: module.Order,
    });

    /*
     The numpad handles both the choice of the property currently being modified
     (quantity, price or discount) and the edition of the corresponding numeric value.
     */
    module.NumpadState = Backbone.Model.extend({
        defaults: {
            buffer: "0",
            mode: "quantity"
        },
        appendNewChar: function (newChar) {
            var oldBuffer;
            oldBuffer = this.get('buffer');
            if (oldBuffer === '0') {
                this.set({
                    buffer: newChar
                });
            } else if (oldBuffer === '-0') {
                this.set({
                    buffer: "-" + newChar
                });
            } else {
                this.set({
                    buffer: (this.get('buffer')) + newChar
                });
            }
            this.trigger('set_value', this.get('buffer'));
        },
        deleteLastChar: function () {
            if (this.get('buffer') === "") {
                if (this.get('mode') === 'quantity') {
                    this.trigger('set_value', 'remove');
                } else {
                    this.trigger('set_value', this.get('buffer'));
                }
            } else {
                var newBuffer = this.get('buffer').slice(0, -1) || "";
                this.set({buffer: newBuffer});
                this.trigger('set_value', this.get('buffer'));
            }
        },
        switchSign: function () {
            var oldBuffer;
            oldBuffer = this.get('buffer');
            this.set({
                buffer: oldBuffer[0] === '-' ? oldBuffer.substr(1) : "-" + oldBuffer
            });
            this.trigger('set_value', this.get('buffer'));
        },
        changeMode: function (newMode) {
            this.set({
                buffer: "0",
                mode: newMode
            });
        },
        reset: function () {
            this.set({
                buffer: "0",
                mode: "quantity"
            });
        },
        resetValue: function () {
            this.set({buffer: '0'});
        },
    });
}

openerp.point_of_sale = function (instance) {

    instance.point_of_sale = {};

    var module = instance.point_of_sale;

    openerp_pos_db(instance, module);         // import db.js

    openerp_pos_models(instance, module);     // import pos_models.js

    openerp_pos_basewidget(instance, module); // import pos_basewidget.js

    openerp_pos_keyboard(instance, module);   // import  pos_keyboard_widget.js

    openerp_pos_screens(instance, module);    // import pos_screens.js

    openerp_pos_devices(instance, module);    // import pos_devices.js

    openerp_pos_widgets(instance, module);    // import pos_widgets.js

    // cashiers
    openerp_pos_cashier(instance, module);       // import openerp_pos_cashier

    instance.web.client_actions.add('pos.ui', 'instance.point_of_sale.PosWidget');
};