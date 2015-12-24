# -*- coding: utf-8 -*-
{
    'name': 'Internal Transfer',
    'version': '1.0',
    'author': 'Mostafa Mohamed',
    "sequence": 1,
    'summary': 'Implement Internal Transfer of  Odoo 9 in Odoo 8 With more enhanced features',
    'category': 'Accounting ',
    'description': """
        Implement Internal Transfer of  Odoo 9 in Odoo 8 and more enhanced
    """,
    'website': 'https://www.odoo.com/',
    'depends': ['base_setup', 'account','account_accountant'],
    'data': ['internal_transfer_view.xml'],

    'installable': True,
    'auto_install': False,
    'application': True,
    }