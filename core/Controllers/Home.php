<?php

namespace Core\Controllers;

use CodeIgniter\Controller;

class Home extends BaseController
{
    public function index()
    {
        // Test database connection
        $db = db_connect();
        if ($db->connect()) {
            echo 'Database connected successfully<br>';

            // Fetch current time from the database
            $query = $db->query("SELECT NOW()");
            $result = $query->getRow();

            if ($result) {
                echo 'Current database time: ' . $result->{'NOW()'};
            } else {
                echo 'Failed to retrieve current time from the database';
            }
        } else {
            echo 'Database connection failed';
        }

        //return view('welcome_message');
    }
}
